import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { getAdminClient } from "../lib/supabase.js";
import { ChatMessageSchema } from "../lib/validation.js";
import { reserveMonthlyQuota, assertConversationTurnLimit, acquireLease, releaseLease, checkRateLimit } from "../lib/limits.js";
import { createEmbedding, streamChat } from "../lib/nim.js";
import { retrieveRelevantChunks, buildPromptWithContext } from "../lib/retrieve.js";
import { CONFIG } from "../config.js";

export const widgetRouter = Router();

/**
 * Validates request origin against the assistant's configured allowed_origins.
 */
function handleCorsAndOrigin(
  req: Request,
  res: Response,
  allowedOrigins: string[] = []
): boolean {
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : "");

  // If assistant has configured origins, enforce exact match
  if (allowedOrigins.length > 0) {
    const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes("*");
    if (!isAllowed) {
      res.setHeader("Vary", "Origin");
      res.status(403).json({ error: "Origin not allowed to embed this assistant." });
      return false;
    }
  }

  // Set appropriate CORS headers
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Capability-Token, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return false;
  }

  return true;
}

/**
 * GET /api/widget/:publicId/config
 * Returns safe public customization settings.
 */
widgetRouter.all("/:publicId/config", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { publicId } = req.params;

  const { data: assistant, error } = await supabase
    .from("assistants")
    .select("id, name, welcome_message, brand_color, suggested_questions, status, allowed_origins")
    .eq("public_id", publicId)
    .maybeSingle();

  if (error || !assistant) {
    res.status(404).json({ error: "Assistant not found or offline." });
    return;
  }

  if (assistant.status !== "published" && publicId !== CONFIG.DEMO_ASSISTANT_PUBLIC_ID) {
    res.status(403).json({ error: "This assistant is currently in draft mode and not published." });
    return;
  }

  if (!handleCorsAndOrigin(req, res, assistant.allowed_origins)) {
    return;
  }

  res.json({
    publicId,
    name: assistant.name,
    welcomeMessage: assistant.welcome_message,
    brandColor: assistant.brand_color,
    suggestedQuestions: assistant.suggested_questions || []
  });
});

/**
 * POST /api/widget/:publicId/session
 * Generates an opaque, expiring capability token for a new visitor chat session.
 */
widgetRouter.all("/:publicId/session", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { publicId } = req.params;

  const { data: assistant } = await supabase
    .from("assistants")
    .select("id, workspace_id, status, allowed_origins")
    .eq("public_id", publicId)
    .maybeSingle();

  if (!assistant || (assistant.status !== "published" && publicId !== CONFIG.DEMO_ASSISTANT_PUBLIC_ID)) {
    res.status(404).json({ error: "Assistant not found or not published." });
    return;
  }

  if (!handleCorsAndOrigin(req, res, assistant.allowed_origins)) {
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Generate cryptographic token
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + CONFIG.LIMITS.CONVERSATION_CAPABILITY_TTL_HOURS * 3600 * 1000).toISOString();
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : "");

  // Create public conversation record
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .insert({
      workspace_id: assistant.workspace_id,
      assistant_id: assistant.id,
      mode: "public",
      origin: origin || null,
      capability_hash: tokenHash,
      capability_expires_at: expiresAt,
      turn_count: 0
    })
    .select("id")
    .single();

  if (convErr || !conv) {
    res.status(500).json({ error: "Failed to initialize visitor conversation session." });
    return;
  }

  res.json({
    sessionToken: token,
    conversationId: conv.id,
    expiresAt
  });
});

/**
 * POST /api/widget/:publicId/chat
 * Streams grounded AI answers for public website visitors.
 */
widgetRouter.all("/:publicId/chat", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { publicId } = req.params;

  const { data: assistant } = await supabase
    .from("assistants")
    .select("id, workspace_id, name, tone, fallback_info, status, allowed_origins")
    .eq("public_id", publicId)
    .maybeSingle();

  if (!assistant || (assistant.status !== "published" && publicId !== CONFIG.DEMO_ASSISTANT_PUBLIC_ID)) {
    res.status(404).json({ error: "Assistant not found or offline." });
    return;
  }

  if (!handleCorsAndOrigin(req, res, assistant.allowed_origins)) {
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Capability token check
  const capabilityToken = (req.headers["x-capability-token"] as string) || req.body?.capabilityToken;
  if (!capabilityToken) {
    res.status(401).json({ error: "Missing conversation session capability token." });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(capabilityToken).digest("hex");
  const nowIso = new Date().toISOString();

  // Validate active conversation
  const { data: conversation, error: convErr } = await supabase
    .from("conversations")
    .select("id, turn_count, capability_expires_at")
    .eq("assistant_id", assistant.id)
    .eq("capability_hash", tokenHash)
    .gt("capability_expires_at", nowIso)
    .maybeSingle();

  if (convErr || !conversation) {
    res.status(401).json({ error: "Conversation session has expired or is invalid. Please start a new session." });
    return;
  }

  // Turn limit check (max 20)
  assertConversationTurnLimit(conversation.turn_count);

  const parseResult = ChatMessageSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.flatten() });
    return;
  }

  const { message: userText, requestId } = parseResult.data;

  // Rate limit by IP hash
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "127.0.0.1";
  const ipHash = crypto.createHmac("sha256", CONFIG.RATE_LIMIT_SALT).update(clientIp).digest("hex");
  const rateLimitKey = `rl:ip:${ipHash}`;

  try {
    await checkRateLimit(supabase, rateLimitKey);
  } catch (err: unknown) {
    res.status(429).json({ error: (err as Error).message });
    return;
  }

  // Reserve monthly quota (first turn of conversation counts toward monthly conversations)
  const isFirstTurn = conversation.turn_count === 0;
  try {
    await reserveMonthlyQuota(supabase, assistant.workspace_id, { isNewConversation: isFirstTurn });
  } catch (err: unknown) {
    res.status(429).json({ error: (err as Error).message });
    return;
  }

  // Concurrency lease
  const leaseKey = `lease:public:${conversation.id}:${requestId || "req"}`;
  const acquired = await acquireLease(supabase, leaseKey, 45);
  if (!acquired) {
    res.status(409).json({ error: "A message is already being processed for this session." });
    return;
  }

  // SSE streaming setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: meta\ndata: ${JSON.stringify({ conversationId: conversation.id })}\n\n`);

  try {
    // 1. Record user turn
    await supabase.from("messages").insert({
      workspace_id: assistant.workspace_id,
      assistant_id: assistant.id,
      conversation_id: conversation.id,
      role: "user",
      content: userText,
      request_id: requestId
    });

    // 2. Vector retrieval
    const queryVector = await createEmbedding(userText, "query");
    const retrievedChunks = await retrieveRelevantChunks(supabase, queryVector, assistant.id);

    // 3. Context history
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(6);

    const history = (recentMessages || []).reverse().map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content
    }));

    // 4. Grounded prompt & safe source references
    const { messages: promptMessages, sources } = buildPromptWithContext(
      assistant,
      retrievedChunks,
      history.slice(0, -1),
      userText
    );

    if (sources.length > 0) {
      res.write(`event: sources\ndata: ${JSON.stringify({ sources })}\n\n`);
    }

    let fullAnswer = "";

    // 5. Stream from NIM
    await streamChat(
      promptMessages,
      {
        onDelta: (chunk) => {
          fullAnswer += chunk;
          res.write(`event: delta\ndata: ${JSON.stringify({ delta: chunk })}\n\n`);
        },
        onDone: async (usage) => {
          await supabase.from("messages").insert({
            workspace_id: assistant.workspace_id,
            assistant_id: assistant.id,
            conversation_id: conversation.id,
            role: "assistant",
            content: fullAnswer,
            sources,
            tokens_used: usage?.total_tokens || 0
          });

          await supabase
            .from("conversations")
            .update({ turn_count: conversation.turn_count + 1 })
            .eq("id", conversation.id);

          res.write(`event: done\ndata: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
    res.end();
  } finally {
    await releaseLease(supabase, leaseKey);
  }
});

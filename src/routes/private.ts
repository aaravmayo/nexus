import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { getAdminClient } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { AssistantUpdateSchema, AddSourceSchema, ChatMessageSchema } from "../lib/validation.js";
import { reserveMonthlyQuota, assertConversationTurnLimit, acquireLease, releaseLease, getCurrentYearMonth } from "../lib/limits.js";
import { createEmbedding, streamChat } from "../lib/nim.js";
import { retrieveRelevantChunks, buildPromptWithContext } from "../lib/retrieve.js";
import { runIngestionJob } from "../workflows/ingest.js";
import { CONFIG } from "../config.js";

export const privateRouter = Router();

// All routes here require authentication
privateRouter.use(requireAuth);

/**
 * GET /api/workspaces
 * Returns authenticated user's workspace, assistant, and limits.
 */
privateRouter.get("/workspaces", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const workspace = req.workspace!;
  const assistant = req.assistant!;

  const { data: fullAssistant } = await supabase
    .from("assistants")
    .select("*")
    .eq("id", assistant.id)
    .single();

  const { data: usage } = await supabase
    .from("usage_periods")
    .select("*")
    .eq("workspace_id", workspace.id)
    .eq("year_month", getCurrentYearMonth())
    .maybeSingle();

  res.json({
    workspace,
    assistant: fullAssistant || assistant,
    usage: {
      yearMonth: getCurrentYearMonth(),
      conversationsCount: usage?.conversations_count || 0,
      messagesCount: usage?.messages_count || 0,
      ingestedCharsCount: usage?.ingested_chars_count || 0,
      limits: CONFIG.LIMITS
    }
  });
});

/**
 * PATCH /api/assistants/:id
 * Updates assistant customization and allowed origins.
 */
privateRouter.patch("/assistants/:id", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const assistantId = req.params.id;

  // Strict tenant verification
  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied to requested assistant." });
    return;
  }

  const parseResult = AssistantUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.flatten() });
    return;
  }

  const updates = parseResult.data;

  // Publishing check: requires ready sources and at least one allowed origin
  if (updates.status === "published") {
    const { count } = await supabase
      .from("sources")
      .select("id", { count: "exact", head: true })
      .eq("assistant_id", assistantId)
      .eq("status", "ready");

    if (!count || count === 0) {
      res.status(400).json({ error: "Cannot publish assistant without at least one ready knowledge source." });
      return;
    }
  }

  const { data: updated, error } = await supabase
    .from("assistants")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("id", assistantId)
    .select("*")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ assistant: updated });
});

/**
 * GET /api/assistants/:id/sources
 * Lists knowledge sources for the assistant.
 */
privateRouter.get("/assistants/:id/sources", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const assistantId = req.params.id;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const { data: sources, error } = await supabase
    .from("sources")
    .select("id, type, title, location, status, error_message, char_count, chunk_count, created_at, updated_at")
    .eq("assistant_id", assistantId)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ sources: sources || [] });
});

/**
 * POST /api/assistants/:id/sources
 * Creates a new source and initiates ingestion.
 */
privateRouter.post("/assistants/:id/sources", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const assistantId = req.params.id;
  const workspaceId = req.workspace!.id;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const parseResult = AddSourceSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.flatten() });
    return;
  }

  const data = parseResult.data;

  // File upload: create signed URL
  if (data.type === "file") {
    const fileId = crypto.randomUUID();
    const storagePath = `${assistantId}/${fileId}-${data.fileName}`;

    // Create signed upload URL from Supabase Storage
    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from("knowledge-files")
      .createSignedUploadUrl(storagePath);

    if (uploadErr) {
      res.status(500).json({ error: `Storage upload preparation failed: ${uploadErr.message}` });
      return;
    }

    // Insert pending source
    const { data: source, error: srcErr } = await supabase
      .from("sources")
      .insert({
        workspace_id: workspaceId,
        assistant_id: assistantId,
        type: "file",
        title: data.fileName,
        storage_path: storagePath,
        status: "pending"
      })
      .select("id")
      .single();

    if (srcErr || !source) {
      res.status(500).json({ error: "Failed to create file source record." });
      return;
    }

    res.json({
      sourceId: source.id,
      storagePath,
      signedUrl: uploadData.signedUrl,
      token: uploadData.token
    });
    return;
  }

  // Handle website, text, faq
  let title = "Source";
  let location = "";

  if (data.type === "website") {
    title = data.url;
    location = data.url;
  } else if (data.type === "text") {
    title = data.title;
    location = data.content;
  } else if (data.type === "faq") {
    title = data.title;
    location = JSON.stringify(data.items);
  }

  const { data: source, error: srcErr } = await supabase
    .from("sources")
    .insert({
      workspace_id: workspaceId,
      assistant_id: assistantId,
      type: data.type,
      title,
      location,
      status: "pending"
    })
    .select("id")
    .single();

  if (srcErr || !source) {
    res.status(500).json({ error: srcErr?.message || "Failed to create source" });
    return;
  }

  // Create ingestion job
  const { data: job, error: jobErr } = await supabase
    .from("ingestion_jobs")
    .insert({
      workspace_id: workspaceId,
      assistant_id: assistantId,
      source_id: source.id,
      status: "pending"
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    res.status(500).json({ error: "Failed to create ingestion job" });
    return;
  }

  // Asynchronously dispatch the ingestion job
  setImmediate(() => {
    runIngestionJob(job.id).catch(err => {
      console.error(`Ingestion job ${job.id} background failure:`, err);
    });
  });

  res.status(202).json({
    sourceId: source.id,
    jobId: job.id,
    status: "pending"
  });
});

/**
 * POST /api/assistants/:id/sources/:sourceId/finalize-file
 * Finalizes file upload after direct client upload to Supabase storage.
 */
privateRouter.post("/assistants/:id/sources/:sourceId/finalize-file", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { id: assistantId, sourceId } = req.params;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const { data: source } = await supabase
    .from("sources")
    .select("*")
    .eq("id", sourceId)
    .eq("assistant_id", assistantId)
    .maybeSingle();

  if (!source || source.type !== "file") {
    res.status(404).json({ error: "File source not found." });
    return;
  }

  // Create ingestion job
  const { data: job, error: jobErr } = await supabase
    .from("ingestion_jobs")
    .insert({
      workspace_id: req.workspace!.id,
      assistant_id: assistantId,
      source_id: source.id,
      status: "pending"
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    res.status(500).json({ error: "Failed to start file ingestion job." });
    return;
  }

  setImmediate(() => {
    runIngestionJob(job.id).catch(err => console.error("Job failure:", err));
  });

  res.status(202).json({ jobId: job.id, status: "pending" });
});

/**
 * DELETE /api/assistants/:id/sources/:sourceId
 * Deletes source and all associated chunks.
 */
privateRouter.delete("/assistants/:id/sources/:sourceId", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { id: assistantId, sourceId } = req.params;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  // Delete chunks and source
  await supabase.from("chunks").delete().eq("source_id", sourceId);
  await supabase.from("ingestion_jobs").delete().eq("source_id", sourceId);
  const { error } = await supabase.from("sources").delete().eq("id", sourceId).eq("assistant_id", assistantId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

/**
 * GET /api/assistants/:id/jobs/:jobId
 * Returns progress and status of an ingestion job.
 */
privateRouter.get("/assistants/:id/jobs/:jobId", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { id: assistantId, jobId } = req.params;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const { data: job, error } = await supabase
    .from("ingestion_jobs")
    .select("id, status, progress, extracted_chars, chunks_created, error_message, updated_at")
    .eq("id", jobId)
    .eq("assistant_id", assistantId)
    .maybeSingle();

  if (error || !job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ job });
});

/**
 * POST /api/assistants/:id/preview/chat
 * Authenticated preview chat with SSE streaming.
 */
privateRouter.post("/assistants/:id/preview/chat", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const assistantId = req.params.id;
  const workspaceId = req.workspace!.id;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const parseResult = ChatMessageSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.flatten() });
    return;
  }

  const { message: userText, requestId } = parseResult.data;

  // Retrieve or create preview conversation for this user
  let conversationId = req.headers["x-conversation-id"] as string | undefined;
  let isNewConversation = false;

  if (!conversationId) {
    isNewConversation = true;
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .insert({
        workspace_id: workspaceId,
        assistant_id: assistantId,
        mode: "preview",
        turn_count: 0
      })
      .select("id, turn_count")
      .single();

    if (convErr || !conv) {
      res.status(500).json({ error: "Failed to initialize preview conversation" });
      return;
    }
    conversationId = conv.id;
  }

  // Fetch current turn count
  const { data: convData } = await supabase
    .from("conversations")
    .select("turn_count")
    .eq("id", conversationId)
    .single();

  const currentTurns = convData?.turn_count || 0;
  assertConversationTurnLimit(currentTurns);

  // Reserve monthly quota
  await reserveMonthlyQuota(supabase, workspaceId, { isNewConversation });

  // Lease for concurrency / idempotency
  const leaseKey = `lease:preview:${conversationId}:${requestId || "req"}`;
  const acquired = await acquireLease(supabase, leaseKey, 45);
  if (!acquired) {
    res.status(409).json({ error: "A response is already generating for this conversation." });
    return;
  }

  // Set SSE Headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send conversation ID
  res.write(`event: meta\ndata: ${JSON.stringify({ conversationId })}\n\n`);

  try {
    // 1. Record user message
    await supabase.from("messages").insert({
      workspace_id: workspaceId,
      assistant_id: assistantId,
      conversation_id: conversationId,
      role: "user",
      content: userText,
      request_id: requestId
    });

    // 2. Fetch assistant details
    const { data: assistant } = await supabase
      .from("assistants")
      .select("name, tone, fallback_info")
      .eq("id", assistantId)
      .single();

    // 3. Generate embedding for query & retrieve relevant knowledge
    const queryVector = await createEmbedding(userText, "query");
    const retrievedChunks = await retrieveRelevantChunks(supabase, queryVector, assistantId);

    // 4. Fetch recent conversation history
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(6);

    const history = (recentMessages || []).reverse().map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content
    }));

    // 5. Construct grounded prompt & source references
    const { messages: promptMessages, sources } = buildPromptWithContext(
      assistant || { name: "Nexus" },
      retrievedChunks,
      history.slice(0, -1), // Exclude the current user turn just recorded
      userText
    );

    // Send sources event
    if (sources.length > 0) {
      res.write(`event: sources\ndata: ${JSON.stringify({ sources })}\n\n`);
    }

    let fullAnswer = "";

    // 6. Stream from NIM
    await streamChat(
      promptMessages,
      {
        onDelta: (chunk) => {
          fullAnswer += chunk;
          res.write(`event: delta\ndata: ${JSON.stringify({ delta: chunk })}\n\n`);
        },
        onDone: async (usage) => {
          // Persist assistant response
          await supabase.from("messages").insert({
            workspace_id: workspaceId,
            assistant_id: assistantId,
            conversation_id: conversationId,
            role: "assistant",
            content: fullAnswer,
            sources,
            tokens_used: usage?.total_tokens || 0
          });

          // Increment turn count
          await supabase
            .from("conversations")
            .update({ turn_count: currentTurns + 1 })
            .eq("id", conversationId);

          res.write(`event: done\ndata: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      },
      req.socket ? undefined : undefined
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
    res.end();
  } finally {
    await releaseLease(supabase, leaseKey);
  }
});

/**
 * GET /api/assistants/:id/conversations
 * Lists private conversations.
 */
privateRouter.get("/assistants/:id/conversations", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const assistantId = req.params.id;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const { data: convs, error } = await supabase
    .from("conversations")
    .select("id, mode, origin, turn_count, created_at, updated_at")
    .eq("assistant_id", assistantId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ conversations: convs || [] });
});

/**
 * DELETE /api/assistants/:id/conversations/:convId
 * Deletes a conversation and its messages.
 */
privateRouter.delete("/assistants/:id/conversations/:convId", async (req: Request, res: Response): Promise<void> => {
  const supabase = getAdminClient();
  const { id: assistantId, convId } = req.params;

  if (req.assistant?.id !== assistantId) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  await supabase.from("messages").delete().eq("conversation_id", convId);
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", convId)
    .eq("assistant_id", assistantId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

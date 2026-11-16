import { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../config.js";

export class LimitExceededError extends Error {
  constructor(message: string, public statusCode: number = 429) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export function getCurrentYearMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Checks and reserves monthly quota atomically via RPC or upsert.
 */
export async function reserveMonthlyQuota(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { isNewConversation?: boolean } = {}
): Promise<void> {
  const ym = getCurrentYearMonth();
  const deltaConv = options.isNewConversation ? 1 : 0;
  const deltaMsg = 1;

  // 1. Fetch current usage for the month
  const { data: usage, error: fetchError } = await supabase
    .from("usage_periods")
    .select("conversations_count, messages_count")
    .eq("workspace_id", workspaceId)
    .eq("year_month", ym)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to query usage limits: ${fetchError.message}`);
  }

  const currentConv = usage?.conversations_count || 0;
  const currentMsg = usage?.messages_count || 0;

  if (options.isNewConversation && currentConv + deltaConv > CONFIG.LIMITS.MAX_CONVERSATIONS_PER_MONTH) {
    throw new LimitExceededError(
      `Monthly conversation limit reached (${CONFIG.LIMITS.MAX_CONVERSATIONS_PER_MONTH} conversations/month). Limit resets on the 1st of next month UTC.`,
      429
    );
  }

  if (currentMsg + deltaMsg > CONFIG.LIMITS.MAX_MESSAGES_PER_MONTH) {
    throw new LimitExceededError(
      `Monthly message limit reached (${CONFIG.LIMITS.MAX_MESSAGES_PER_MONTH} messages/month). Limit resets on the 1st of next month UTC.`,
      429
    );
  }

  // Atomically increment using the increment_monthly_usage RPC
  const { error: incError } = await supabase.rpc("increment_monthly_usage", {
    target_workspace_id: workspaceId,
    target_year_month: ym,
    delta_conversations: deltaConv,
    delta_messages: deltaMsg,
    delta_ingested_chars: 0
  });

  if (incError) {
    throw new Error(`Failed to update usage: ${incError.message}`);
  }
}

/**
 * Verifies per-conversation turn count (maximum 20 turns)
 */
export function assertConversationTurnLimit(currentTurns: number): void {
  if (currentTurns >= CONFIG.LIMITS.MAX_USER_TURNS_PER_CONVERSATION) {
    throw new LimitExceededError(
      `Conversation limit reached (maximum ${CONFIG.LIMITS.MAX_USER_TURNS_PER_CONVERSATION} turns per conversation). Please start a new conversation.`,
      400
    );
  }
}

/**
 * Distributed concurrency lease to prevent duplicate requests / replay attacks.
 */
export async function acquireLease(
  supabase: SupabaseClient,
  leaseKey: string,
  ttlSeconds = 30
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const nowIso = new Date().toISOString();

  // Clean expired or insert
  await supabase
    .from("rate_limit_buckets")
    .delete()
    .eq("key", leaseKey)
    .lt("expires_at", nowIso);

  const { error } = await supabase
    .from("rate_limit_buckets")
    .insert({
      key: leaseKey,
      count: 1,
      expires_at: expiresAt
    });

  if (error) {
    // Already leased / concurrent duplicate
    return false;
  }
  return true;
}

export async function releaseLease(
  supabase: SupabaseClient,
  leaseKey: string
): Promise<void> {
  await supabase
    .from("rate_limit_buckets")
    .delete()
    .eq("key", leaseKey);
}

/**
 * Sliding window rate limit check.
 */
export async function checkRateLimit(
  supabase: SupabaseClient,
  bucketKey: string,
  maxRequests = CONFIG.LIMITS.CHAT_RATE_LIMIT_MAX_REQUESTS,
  windowSeconds = CONFIG.LIMITS.CHAT_RATE_LIMIT_WINDOW_SEC
): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // First delete expired entry
  await supabase
    .from("rate_limit_buckets")
    .delete()
    .eq("key", bucketKey)
    .lt("expires_at", nowIso);

  const { data: existing } = await supabase
    .from("rate_limit_buckets")
    .select("count, expires_at")
    .eq("key", bucketKey)
    .maybeSingle();

  if (existing) {
    if (existing.count >= maxRequests) {
      throw new LimitExceededError(
        `Too many requests. Please wait a moment before trying again.`,
        429
      );
    }

    await supabase
      .from("rate_limit_buckets")
      .update({ count: existing.count + 1 })
      .eq("key", bucketKey);
  } else {
    const expiresAt = new Date(now + windowSeconds * 1000).toISOString();
    await supabase
      .from("rate_limit_buckets")
      .insert({
        key: bucketKey,
        count: 1,
        expires_at: expiresAt
      });
  }
}

/**
 * Validates active knowledge caps before ingesting new content into an assistant.
 */
export async function assertIngestionCaps(
  supabase: SupabaseClient,
  assistantId: string,
  workspaceId: string,
  proposed: {
    newChars?: number;
    newChunks?: number;
    isPage?: boolean;
    isFile?: boolean;
  }
): Promise<void> {
  const ym = getCurrentYearMonth();

  // 1. Check monthly re-ingestion cap
  const { data: monthlyUsage } = await supabase
    .from("usage_periods")
    .select("ingested_chars_count")
    .eq("workspace_id", workspaceId)
    .eq("year_month", ym)
    .maybeSingle();

  const currentMonthlyChars = monthlyUsage?.ingested_chars_count || 0;
  if (currentMonthlyChars + (proposed.newChars || 0) > CONFIG.LIMITS.MAX_INGESTED_CHARS_PER_MONTH) {
    throw new LimitExceededError(
      `Monthly re-ingestion budget exceeded (${CONFIG.LIMITS.MAX_INGESTED_CHARS_PER_MONTH.toLocaleString()} characters/month). Prevents embedding budget exhaustion.`,
      429
    );
  }

  // 2. Query active sources for this assistant
  const { data: sources, error } = await supabase
    .from("sources")
    .select("type, status, char_count, chunk_count")
    .eq("assistant_id", assistantId);

  if (error) {
    throw new Error(`Failed to query existing assistant sources: ${error.message}`);
  }

  const activeSources = (sources || []).filter(s => s.status === "ready" || s.status === "processing");
  const totalChars = activeSources.reduce((acc, s) => acc + (s.char_count || 0), 0);
  const totalChunks = activeSources.reduce((acc, s) => acc + (s.chunk_count || 0), 0);
  const activeFiles = activeSources.filter(s => s.type === "file").length;
  const activePages = activeSources.filter(s => s.type === "website").length;

  if (proposed.isFile && activeFiles + 1 > CONFIG.LIMITS.MAX_ACTIVE_FILES) {
    throw new LimitExceededError(
      `File limit reached (maximum ${CONFIG.LIMITS.MAX_ACTIVE_FILES} active files per assistant).`,
      400
    );
  }

  if (proposed.isPage && activePages + 1 > CONFIG.LIMITS.MAX_ACTIVE_WEBSITE_PAGES) {
    throw new LimitExceededError(
      `Website page limit reached (maximum ${CONFIG.LIMITS.MAX_ACTIVE_WEBSITE_PAGES} active pages per assistant).`,
      400
    );
  }

  if (totalChars + (proposed.newChars || 0) > CONFIG.LIMITS.MAX_ACTIVE_EXTRACTED_CHARS) {
    throw new LimitExceededError(
      `Assistant character limit reached (maximum ${CONFIG.LIMITS.MAX_ACTIVE_EXTRACTED_CHARS.toLocaleString()} characters). Please delete unused sources to free up space.`,
      400
    );
  }

  if (totalChunks + (proposed.newChunks || 0) > CONFIG.LIMITS.MAX_ACTIVE_CHUNKS) {
    throw new LimitExceededError(
      `Assistant chunk limit reached (maximum ${CONFIG.LIMITS.MAX_ACTIVE_CHUNKS} chunks).`,
      400
    );
  }
}

import { Router, Request, Response } from "express";
import { getAdminClient } from "../lib/supabase.js";
import { CONFIG } from "../config.js";

export const internalRouter = Router();

/**
 * POST /api/internal/cleanup
 * Protected maintenance endpoint to prune expired leases, capability tokens,
 * and enforce the 30-day conversation retention policy.
 */
internalRouter.post("/cleanup", async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CONFIG.CLEANUP_SECRET}`) {
    res.status(401).json({ error: "Unauthorized cleanup request" });
    return;
  }

  const supabase = getAdminClient();
  const nowIso = new Date().toISOString();

  // 1. Delete expired rate limit buckets and leases
  const { count: deletedBuckets } = await supabase
    .from("rate_limit_buckets")
    .delete({ count: "exact" })
    .lt("expires_at", nowIso);

  // 2. 30-day transcript retention policy
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Find old conversations
  const { data: oldConversations } = await supabase
    .from("conversations")
    .select("id")
    .lt("created_at", thirtyDaysAgo);

  let deletedMessagesCount = 0;
  let deletedConversationsCount = 0;

  if (oldConversations && oldConversations.length > 0) {
    const convIds = oldConversations.map(c => c.id);

    const { count: msgCount } = await supabase
      .from("messages")
      .delete({ count: "exact" })
      .in("conversation_id", convIds);

    deletedMessagesCount = msgCount || 0;

    const { count: convCount } = await supabase
      .from("conversations")
      .delete({ count: "exact" })
      .in("id", convIds);

    deletedConversationsCount = convCount || 0;
  }

  res.json({
    status: "ok",
    deletedExpiredBuckets: deletedBuckets || 0,
    retentionPurgedConversations: deletedConversationsCount,
    retentionPurgedMessages: deletedMessagesCount
  });
});

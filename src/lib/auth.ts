import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { getAdminClient } from "./supabase.js";
import { isSupabaseConfigured } from "../config.js";

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export interface WorkspaceContext {
  id: string;
  owner_id: string;
  name: string;
}

export interface AssistantContext {
  id: string;
  workspace_id: string;
  public_id: string;
  name: string;
  status: "draft" | "published";
  allowed_origins: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      workspace?: WorkspaceContext;
      assistant?: AssistantContext;
      accessToken?: string;
    }
  }
}

/**
 * Express middleware that validates the Supabase JWT access token and derives
 * workspace and assistant access server-side.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Token not provided" });
    return;
  }

  if (!isSupabaseConfigured()) {
    // In local dev without Supabase configured, report clearly
    res.status(503).json({ error: "Authentication service not configured. Missing Supabase settings." });
    return;
  }

  try {
    const supabase = getAdminClient();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: "Invalid or expired session. Please log in again." });
      return;
    }

    req.user = { id: user.id, email: user.email };
    req.accessToken = token;

    // Derive or bootstrap workspace for this user
    let { data: workspace } = await supabase
      .from("workspaces")
      .select("id, owner_id, name")
      .eq("owner_id", user.id)
      .maybeSingle();

    if (!workspace) {
      // Idempotently create workspace
      const defaultName = user.email ? `${user.email.split("@")[0]}'s Workspace` : "My Workspace";
      const { data: newWs, error: wsError } = await supabase
        .from("workspaces")
        .insert({
          owner_id: user.id,
          name: defaultName
        })
        .select("id, owner_id, name")
        .single();

      if (wsError || !newWs) {
        res.status(500).json({ error: "Failed to initialize workspace." });
        return;
      }
      workspace = newWs;
    }

    req.workspace = workspace;

    // Derive or bootstrap the 1 assistant for this workspace
    let { data: assistant } = await supabase
      .from("assistants")
      .select("id, workspace_id, public_id, name, status, allowed_origins")
      .eq("workspace_id", workspace.id)
      .maybeSingle();

    if (!assistant) {
      const publicId = crypto.randomBytes(12).toString("hex");
      const { data: newAst, error: astError } = await supabase
        .from("assistants")
        .insert({
          workspace_id: workspace.id,
          public_id: publicId,
          name: "Nexus",
          status: "draft"
        })
        .select("id, workspace_id, public_id, name, status, allowed_origins")
        .single();

      if (astError || !newAst) {
        res.status(500).json({ error: "Failed to initialize assistant." });
        return;
      }
      assistant = newAst;
    }

    req.assistant = assistant;
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Auth validation failed: ${msg}` });
  }
}

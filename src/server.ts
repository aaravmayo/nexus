import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { privateRouter } from "./routes/private.js";
import { widgetRouter } from "./routes/widget.js";
import { internalRouter } from "./routes/internal.js";
import { CONFIG, isSupabaseConfigured } from "./config.js";
import { getAdminClient, getAnonClient } from "./lib/supabase.js";

export const app = express();

const publicDir = path.resolve(process.cwd(), "public");

// Basic security middleware
app.disable("x-powered-by");

// Restrictive security headers compatible with DM Sans, Supabase, and NIM
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' https://*.supabase.co https://integrate.api.nvidia.com; " +
    "img-src 'self' data:; " +
    "frame-ancestors 'self';"
  );
  next();
});

// Serve static files from public/ if present, fallback to process.cwd()
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(process.cwd()));

app.use(express.json({ limit: "4.5mb" })); // Vercel function body limit
app.use(express.urlencoded({ extended: true }));

// Standard CORS for API routes
app.use(cors({
  origin: true,
  credentials: true
}));

/**
 * Public browser-safe configuration endpoint.
 * Returns only public Supabase settings and optional demo ID. Never exposes private secrets!
 */
app.get(["/api/config", "/config"], (_req, res) => {
  res.json({
    supabaseUrl: CONFIG.SUPABASE_URL,
    supabaseAnonKey: CONFIG.SUPABASE_ANON_KEY,
    demoAssistantPublicId: CONFIG.DEMO_ASSISTANT_PUBLIC_ID || null,
    isNimConfigured: Boolean(CONFIG.NIM_API_KEY && CONFIG.NIM_API_KEY.trim() !== ""),
    limits: {
      maxConversationsPerMonth: CONFIG.LIMITS.MAX_CONVERSATIONS_PER_MONTH,
      maxMessagesPerMonth: CONFIG.LIMITS.MAX_MESSAGES_PER_MONTH,
      maxTurnsPerConversation: CONFIG.LIMITS.MAX_USER_TURNS_PER_CONVERSATION
    }
  });
});

// Health check endpoint
app.get(["/api/health", "/health"], (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/**
 * Public authentication helper endpoint.
 * Requests a sign-in OTP or falls back gracefully to admin link generation
 * if the Supabase built-in email quota (3/hour) is exceeded.
 */
app.post(["/api/auth/request-code", "/auth/request-code"], async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: "Authentication service is not configured." });
  }

  const cleanEmail = email.trim().toLowerCase();
  const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : "https://nexus-pi-pied.vercel.app");
  const redirectTo = `${origin}/app.html`;

  try {
    // Attempt standard OTP email delivery first
    const client = getAnonClient();
    const { error: otpError } = await client.auth.signInWithOtp({
      email: cleanEmail,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: redirectTo
      }
    });

    if (!otpError) {
      return res.json({ success: true, method: "email" });
    }

    // If rate-limited by Supabase built-in SMTP (or any email transport failure),
    // generate an instant login token/link with the admin client so the user is never locked out.
    const admin = getAdminClient();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: cleanEmail,
      options: {
        redirectTo
      }
    });

    if (linkError || !linkData?.properties) {
      return res.status(400).json({
        error: otpError.message || linkError?.message || "Failed to generate sign-in code."
      });
    }

    return res.json({
      success: true,
      method: "instant",
      rateLimited: otpError.status === 429 || (otpError as any).code === "over_email_send_rate_limit",
      emailOtp: linkData.properties.email_otp,
      actionLink: linkData.properties.action_link
    });
  } catch (err: unknown) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

// Mount modular sub-routers on both /api and root paths (supports Vercel function routing)
app.use("/api/widget", widgetRouter);
app.use("/widget", widgetRouter);
app.use("/api/internal", internalRouter);
app.use("/internal", internalRouter);
app.use("/api", privateRouter);
app.use("/workspaces", privateRouter);
app.use("/assistants", privateRouter);

// Static pages routing fallback
app.get("/", (_req, res) => {
  const publicIndex = path.join(publicDir, "index.html");
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.sendFile(path.resolve(process.cwd(), "index.html"));
});

app.get("/app", (_req, res) => {
  const publicApp = path.join(publicDir, "app.html");
  if (fs.existsSync(publicApp)) {
    return res.sendFile(publicApp);
  }
  res.sendFile(path.resolve(process.cwd(), "app.html"));
});

app.get("/nexus.js", (_req, res) => {
  const nexusPath = path.join(publicDir, "nexus.js");
  if (fs.existsSync(nexusPath)) {
    return res.sendFile(nexusPath);
  }
  res.sendFile(path.resolve(process.cwd(), "nexus.js"));
});

// Centralized error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  const statusCode = (err as any)?.statusCode || 500;
  res.status(statusCode).json({ error: message });
});

export default app;

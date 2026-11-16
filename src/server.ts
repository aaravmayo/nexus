import express from "express";
import cors from "cors";
import { privateRouter } from "./routes/private.js";
import { widgetRouter } from "./routes/widget.js";
import { internalRouter } from "./routes/internal.js";
import { CONFIG } from "./config.js";

export const app = express();

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
app.get("/api/config", (_req, res) => {
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

// Mount modular sub-routers
app.use("/api", privateRouter);
app.use("/api/widget", widgetRouter);
app.use("/api/internal", internalRouter);

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Centralized error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  const statusCode = (err as any)?.statusCode || 500;
  res.status(statusCode).json({ error: message });
});

export default app;

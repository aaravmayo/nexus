import dotenv from "dotenv";

dotenv.config();

export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  NODE_ENV: process.env.NODE_ENV || "development",
  APP_ORIGIN: process.env.APP_ORIGIN || "http://localhost:3000",

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",

  // NVIDIA NIM Configuration
  NIM_API_KEY: process.env.NIM_API_KEY || "",
  NIM_BASE_URL: (process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  NIM_CHAT_MODEL: process.env.NIM_CHAT_MODEL || "meta/llama-3.1-8b-instruct",
  NIM_EMBED_MODEL: process.env.NIM_EMBED_MODEL || "baai/bge-m3",
  NIM_EMBED_DIMENSION: parseInt(process.env.NIM_EMBED_DIMENSION || "1024", 10),
  NIM_TIMEOUT_MS: parseInt(process.env.NIM_TIMEOUT_MS || "30000", 10),
  NIM_CONCURRENCY_LIMIT: parseInt(process.env.NIM_CONCURRENCY_LIMIT || "10", 10),

  // Secrets & Salts
  RATE_LIMIT_SALT: process.env.RATE_LIMIT_SALT || "nexus-salt-change-in-production",
  CLEANUP_SECRET: process.env.CLEANUP_SECRET || "nexus-cleanup-secret",
  DEMO_ASSISTANT_PUBLIC_ID: process.env.DEMO_ASSISTANT_PUBLIC_ID || "",

  // Global kill-switch
  INFERENCE_KILL_SWITCH: process.env.INFERENCE_KILL_SWITCH === "true",

  // Free Beta Server Limits
  LIMITS: {
    // Workspace calendar month limits (UTC)
    MAX_CONVERSATIONS_PER_MONTH: 100,
    MAX_MESSAGES_PER_MONTH: 1000,
    MAX_INGESTED_CHARS_PER_MONTH: 1000000, // Monthly re-ingestion cap to prevent embedding budget drain

    // Per conversation limits
    MAX_USER_TURNS_PER_CONVERSATION: 20,
    CONVERSATION_CAPABILITY_TTL_HOURS: 24,

    // Per assistant active ingestion caps
    MAX_ACTIVE_WEBSITE_PAGES: 25,
    MAX_ACTIVE_FILES: 5,
    MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
    MAX_ACTIVE_EXTRACTED_CHARS: 250000,
    MAX_ACTIVE_CHUNKS: 1000,

    // Chunking configuration
    CHUNK_SIZE_CHARS: 1200,
    CHUNK_OVERLAP_CHARS: 200,

    // RAG Retrieval parameters
    RAG_TOP_K: 5,
    RAG_SIMILARITY_THRESHOLD: 0.35,

    // Rate limiting
    CHAT_RATE_LIMIT_WINDOW_SEC: 60,
    CHAT_RATE_LIMIT_MAX_REQUESTS: 20,
    INGEST_CONCURRENCY_PER_ASSISTANT: 1
  }
} as const;

export function isNimConfigured(): boolean {
  return Boolean(CONFIG.NIM_API_KEY && CONFIG.NIM_API_KEY.trim() !== "");
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_ANON_KEY &&
    CONFIG.SUPABASE_SERVICE_ROLE_KEY
  );
}

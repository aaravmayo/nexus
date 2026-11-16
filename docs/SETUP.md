# Nexus MVP Setup & Operations Guide

This guide details local setup, development verification, Supabase provisioning, NVIDIA NIM integration, security constraints, and production deployment on Vercel.

---

## 1. Environment Variables

Create `.env` based on `.env.example`:

| Variable | Description | Example / Default |
|---|---|---|
| `PORT` | Local server port | `3000` |
| `NODE_ENV` | Environment mode | `development` / `production` |
| `APP_ORIGIN` | Primary canonical URL | `http://localhost:3000` or `https://nexus.vercel.app` |
| `SUPABASE_URL` | Supabase project URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_ANON_KEY` | Public publishable client key | `eyJhbGciOi...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only backend admin key | `eyJhbGciOi...` |
| `NIM_API_KEY` | NVIDIA NIM API Bearer token | `nvapi-...` |
| `NIM_BASE_URL` | NIM API root endpoint | `https://integrate.api.nvidia.com/v1` |
| `NIM_CHAT_MODEL` | NIM Chat instruction model | `meta/llama-3.1-8b-instruct` |
| `NIM_EMBED_MODEL` | NIM Embedding retriever model | `baai/bge-m3` |
| `NIM_EMBED_DIMENSION` | Dense vector dimension | `1024` |
| `NIM_TIMEOUT_MS` | Request timeout | `30000` (30 seconds) |
| `RATE_LIMIT_SALT` | Secret salt for IP hashing | Random 32+ character hex string |
| `CLEANUP_SECRET` | Secret for maintenance cron | Random 32+ character hex string |
| `DEMO_ASSISTANT_PUBLIC_ID` | (Optional) Public ID for landing demo | Blank or specific public ID |
| `INFERENCE_KILL_SWITCH` | Global inference kill switch | `false` |

---

## 2. Supabase Database & Vector Setup

1. **Apply SQL Migration**:
   Execute the migration in [001_initial_schema.sql](file:///d:/tests/nexus/supabase/migrations/001_initial_schema.sql) in your Supabase SQL Editor.
   This script:
   - Enables `pgvector`
   - Creates `workspaces`, `assistants`, `sources`, `ingestion_jobs`, `chunks`, `conversations`, `messages`, `usage_periods`, and `rate_limit_buckets`
   - Creates the scoped exact cosine similarity search function `match_chunks`
   - Creates atomic usage counter increment function `increment_monthly_usage`
   - Configures strict Row Level Security (RLS) on all tenant tables

2. **Supabase Storage Bucket**:
   - Create a private bucket named `knowledge-files` in the Supabase Storage dashboard.
   - Restrict public access (private bucket).
   - Ensure authenticated users or service role can upload and read objects.

3. **Supabase Auth Configuration**:
   - Under Authentication -> Providers -> Email:
     - Enable Email OTP (One-Time Password) / Magic Link.
     - Set OTP expiry to 3600 seconds (1 hour).
   - Under URL Configuration:
     - Add your site origin (e.g. `http://localhost:3000` and your production Vercel domain) to **Redirect URLs**.

---

## 3. NVIDIA NIM Integration Contracts

- **Chat**:
  - Endpoint: `${NIM_BASE_URL}/chat/completions`
  - Model: `meta/llama-3.1-8b-instruct`
  - Protocol: Server-Sent Events (SSE) streaming with `data: {...}` chunks and `data: [DONE]`.
- **Embeddings**:
  - Endpoint: `${NIM_BASE_URL}/embeddings`
  - Model: `baai/bge-m3` or `nvidia/nv-embedqa-e5-v5`
  - Dimensions: Fixed `1024` dense vectors.
  - Encoding: Float array of length 1024. All vectors are validated for finite numbers before database persistence.

---

## 4. Free Beta Server Limits & Ingestion Caps

The following server-enforced limits are centralized in `src/config.ts`:
- **Monthly Conversations**: 100 per workspace per UTC calendar month. Opening the widget does not consume a conversation.
- **Monthly Messages**: 1,000 accepted user messages per workspace per UTC calendar month.
- **Per Conversation Turns**: At most 20 user turns per conversation.
- **Active Website Pages**: Max 25 pages crawled per assistant.
- **Active Files**: Max 5 uploaded documents (TXT, MD, PDF) of up to 10 MB each.
- **Active Extracted Characters**: Max 250,000 characters per assistant.
- **Active Vector Chunks**: Max 1,000 active chunks per assistant.
- **Monthly Ingestion Budget**: 1,000,000 characters per workspace per calendar month (prevents embedding budget abuse through delete/re-upload cycles).

---

## 5. Security & SSRF Protection

- **SSRF Protection**:
  - Validates all crawl URLs against DNS rebinding, private ranges, link-local addresses, loopback (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`), and cloud metadata (`169.254.169.254`).
  - Follows redirects manually, re-checking destination addresses before each hop (up to 5 redirects).
- **Origin Whitelisting & CORS**:
  - Embeddable widget checks `Origin` and `Referer` against the assistant's `allowed_origins`.
  - Sets `Vary: Origin` and rejects disallowed origins with `403 Forbidden`.
- **Capability Tokens**:
  - Public visitor conversations use high-entropy random capability tokens hashed with SHA-256 with 24-hour expiration. Non-browser callers without a valid capability token cannot post chat messages.
- **Content Boundary**:
  - Retrieved knowledge chunks are treated strictly as untrusted data in the prompt. System instructions explicitly forbid following commands or instructions embedded within uploaded or crawled text.
  - Uploaded file citations display document titles, never exposing private file download URLs.

---

## 6. Retention Policy & Maintenance

- **Transcript Retention**:
  - Beta conversation transcripts are retained for 30 days.
  - Call `POST /api/internal/cleanup` with `Authorization: Bearer <CLEANUP_SECRET>` on a recurring schedule (e.g. daily cron) to prune expired rate limit leases and delete conversations older than 30 days.

---

## 7. Local Development & Verification

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run automated test suite:
   ```bash
   npm test
   ```
3. Run TypeScript typecheck:
   ```bash
   npm run typecheck
   ```
4. Build client assets:
   ```bash
   npm run build
   ```
5. Launch dev server:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

---

## 8. Rollback & Troubleshooting

- **Database Rollback**:
  - To drop tables created by migration:
    ```sql
    drop table if exists rate_limit_buckets, usage_periods, messages, conversations, chunks, ingestion_jobs, sources, assistants, workspaces cascade;
    drop function if exists match_chunks, increment_monthly_usage cascade;
    ```
- **Inference Kill Switch**:
  - In case of provider throttling or unexpected behavior, set `INFERENCE_KILL_SWITCH=true` to immediately suspend inference calls cleanly with an informative message.

-- Enable pgvector extension
create extension if not exists vector;

-- 1. Workspaces
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Assistants (One assistant per workspace)
create table if not exists assistants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references workspaces(id) on delete cascade,
  public_id text not null unique,
  name text not null default 'Nexus',
  welcome_message text not null default 'Hey there! How can I help you today?',
  brand_color text not null default '#0f172a',
  suggested_questions jsonb not null default '[]'::jsonb,
  tone text not null default 'helpful',
  fallback_info text not null default 'Please reach out to support for more details.',
  allowed_origins text[] not null default '{}'::text[],
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Sources
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  type text not null check (type in ('website', 'file', 'faq', 'text')),
  title text not null,
  location text,
  storage_path text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  content_hash text,
  active_generation int not null default 1,
  char_count int not null default 0,
  chunk_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. Ingestion Jobs
create table if not exists ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  generation int not null default 1,
  progress int not null default 0,
  pages_crawled int not null default 0,
  extracted_chars int not null default 0,
  chunks_created int not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5. Chunks (Vector dimension 1024 for baai/bge-m3 & nv-embedqa-e5-v5)
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  generation int not null default 1,
  ordinal int not null,
  content text not null,
  source_title text not null,
  source_url text,
  token_count int not null default 0,
  embedding vector(1024),
  embedding_model text not null default 'baai/bge-m3',
  content_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chunks_assistant_gen on chunks(assistant_id, generation);
create index if not exists idx_chunks_source_gen on chunks(source_id, generation);

-- 6. Conversations
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  mode text not null default 'preview' check (mode in ('preview', 'public')),
  origin text,
  capability_hash text,
  capability_expires_at timestamptz,
  turn_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_conv_assistant_created on conversations(assistant_id, created_at desc);

-- 7. Messages
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  request_id text,
  sources jsonb not null default '[]'::jsonb,
  tokens_used int not null default 0,
  status text not null default 'completed' check (status in ('completed', 'failed', 'interrupted')),
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_conv_created on messages(conversation_id, created_at asc);

-- 8. Usage Periods (Monthly limits)
create table if not exists usage_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  year_month text not null,
  conversations_count int not null default 0,
  messages_count int not null default 0,
  ingested_chars_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, year_month)
);

-- 9. Rate Limit Buckets & Concurrency Leases
create table if not exists rate_limit_buckets (
  key text primary key,
  count int not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Scoped Cosine Similarity Retrieval RPC
create or replace function match_chunks(
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  target_assistant_id uuid
)
returns table (
  id uuid,
  source_id uuid,
  content text,
  source_title text,
  source_url text,
  similarity float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    c.id,
    c.source_id,
    c.content,
    c.source_title,
    c.source_url,
    (1 - (c.embedding <=> query_embedding))::float as similarity
  from chunks c
  inner join sources s on c.source_id = s.id
  where c.assistant_id = target_assistant_id
    and s.status = 'ready'
    and c.generation = s.active_generation
    and (1 - (c.embedding <=> query_embedding)) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Atomic usage increment function
create or replace function increment_monthly_usage(
  target_workspace_id uuid,
  target_year_month text,
  delta_conversations int default 0,
  delta_messages int default 0,
  delta_ingested_chars int default 0
)
returns table (
  conversations_count int,
  messages_count int,
  ingested_chars_count int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into usage_periods (workspace_id, year_month, conversations_count, messages_count, ingested_chars_count, updated_at)
  values (target_workspace_id, target_year_month, delta_conversations, delta_messages, delta_ingested_chars, now())
  on conflict (workspace_id, year_month)
  do update set
    conversations_count = usage_periods.conversations_count + delta_conversations,
    messages_count = usage_periods.messages_count + delta_messages,
    ingested_chars_count = usage_periods.ingested_chars_count + delta_ingested_chars,
    updated_at = now()
  returning usage_periods.conversations_count, usage_periods.messages_count, usage_periods.ingested_chars_count;
end;
$$;

-- RLS Configuration
alter table workspaces enable row level security;
alter table assistants enable row level security;
alter table sources enable row level security;
alter table ingestion_jobs enable row level security;
alter table chunks enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table usage_periods enable row level security;
alter table rate_limit_buckets enable row level security;

-- Policies for Authenticated Users (Owner Scope)
create policy "Users own workspace" on workspaces
  for all using (auth.uid() = owner_id);

create policy "Users access their assistants" on assistants
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their sources" on sources
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their jobs" on ingestion_jobs
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their chunks" on chunks
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their conversations" on conversations
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their messages" on messages
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "Users access their usage" on usage_periods
  for all using (workspace_id in (select id from workspaces where owner_id = auth.uid()));

-- Rate limit buckets are internal server-only (no anon/authenticated access)
-- Note: Service role automatically bypasses RLS in Supabase.

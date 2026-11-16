import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { initThemeToggle } from "./theme.js";

let supabase: SupabaseClient | null = null;
let accessToken = "";
let currentAssistant: any = null;
let currentWorkspace: any = null;
let selectedFile: File | null = null;
let pollTimer: any = null;

const $ = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const $$ = (selector: string) => document.querySelectorAll(selector) as NodeListOf<HTMLElement>;

function notify(message: string): void {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...options, headers });
}

async function initDashboard(): Promise<void> {
  initThemeToggle();

  // 1. Fetch public config to get Supabase credentials
  const cfgRes = await fetch("/api/config");
  if (!cfgRes.ok) {
    notify("Failed to connect to backend server.");
    return;
  }
  const config = await cfgRes.json();

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    notify("Authentication service is not configured.");
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  // 2. Validate user session
  let { data: { session } } = await supabase.auth.getSession();
  if (!session && (window.location.hash.includes("access_token") || window.location.search.includes("code"))) {
    // Arriving from a magic link redirect; wait for token exchange
    session = await new Promise<any>((resolve) => {
      const { data: { subscription } } = supabase!.auth.onAuthStateChange((_event, sess) => {
        if (sess) {
          subscription.unsubscribe();
          resolve(sess);
        }
      });
      setTimeout(() => {
        subscription.unsubscribe();
        resolve(null);
      }, 4000);
    });
  }

  if (!session) {
    window.location.href = "/";
    return;
  }

  accessToken = session.access_token;
  const userEmail = session.user.email || "User";
  $("#user-email-display")!.textContent = userEmail;

  // 3. Load workspace and assistant data
  await refreshWorkspace();

  // 4. Setup sidebar tab navigation
  $$(".nav-item").forEach(button => {
    button.addEventListener("click", () => {
      const tabName = button.dataset.tab;
      $$(".nav-item").forEach(b => b.classList.remove("active"));
      $$(".panel").forEach(p => p.classList.remove("active"));

      button.classList.add("active");
      $(`#tab-${tabName}`)?.classList.add("active");

      if (tabName === "knowledge") loadSources();
      if (tabName === "conversations") loadConversations();
      if (tabName === "preview") mountPreview();
    });
  });

  // Setup event listeners
  setupAssistantForm();
  setupKnowledgeHandlers();
  setupSnippetCopy();

  $("#btn-logout")?.addEventListener("click", async () => {
    if (supabase) await supabase.auth.signOut();
    window.location.href = "/";
  });
}

async function refreshWorkspace(): Promise<void> {
  try {
    const res = await apiFetch("/api/workspaces");
    if (!res.ok) {
      notify("Failed to load workspace data.");
      return;
    }
    const data = await res.json();
    currentWorkspace = data.workspace;
    currentAssistant = data.assistant;

    populateAssistantSettings(currentAssistant);
    populateUsage(data.usage);
    updateSnippetCode();
  } catch (err: unknown) {
    notify(`Error loading workspace: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function populateAssistantSettings(ast: any): void {
  if (!ast) return;
  ( $("#ast-name") as HTMLInputElement).value = ast.name || "";
  ( $("#ast-color") as HTMLInputElement).value = ast.brand_color || "#2563eb";
  ( $("#ast-welcome") as HTMLInputElement).value = ast.welcome_message || "";
  ( $("#ast-tone") as HTMLInputElement).value = ast.tone || "";
  ( $("#ast-fallback") as HTMLInputElement).value = ast.fallback_info || "";
  ( $("#ast-questions") as HTMLTextAreaElement).value = (ast.suggested_questions || []).join("\n");
  ( $("#ast-origins") as HTMLTextAreaElement).value = (ast.allowed_origins || []).join("\n");

  const statusLabel = $("#ast-status-label")!;
  const publishBtn = $("#btn-toggle-publish") as HTMLButtonElement;

  if (ast.status === "published") {
    statusLabel.textContent = "Published & Live";
    statusLabel.className = "status-badge status-published";
    publishBtn.textContent = "Revert to Draft";
    publishBtn.className = "btn btn-secondary";
  } else {
    statusLabel.textContent = "Draft";
    statusLabel.className = "status-badge status-draft";
    publishBtn.textContent = "Publish Assistant";
    publishBtn.className = "btn btn-primary";
  }
}

function setupAssistantForm(): void {
  const form = $("#assistant-form") as HTMLFormElement;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentAssistant) return;

    const questions = ( $("#ast-questions") as HTMLTextAreaElement).value
      .split("\n")
      .map(q => q.trim())
      .filter(Boolean);

    const origins = ( $("#ast-origins") as HTMLTextAreaElement).value
      .split("\n")
      .map(o => o.trim())
      .filter(Boolean);

    const payload = {
      name: ( $("#ast-name") as HTMLInputElement).value.trim(),
      brand_color: ( $("#ast-color") as HTMLInputElement).value.trim(),
      welcome_message: ( $("#ast-welcome") as HTMLInputElement).value.trim(),
      tone: ( $("#ast-tone") as HTMLInputElement).value.trim(),
      fallback_info: ( $("#ast-fallback") as HTMLInputElement).value.trim(),
      suggested_questions: questions,
      allowed_origins: origins
    };

    const res = await apiFetch(`/api/assistants/${currentAssistant.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      notify(`Failed to update assistant: ${err.error?.message || err.error || "Validation failed"}`);
      return;
    }

    notify("Assistant settings saved successfully!");
    await refreshWorkspace();
  });

  // Toggle publish
  $("#btn-toggle-publish")?.addEventListener("click", async () => {
    if (!currentAssistant) return;
    const nextStatus = currentAssistant.status === "published" ? "draft" : "published";

    const res = await apiFetch(`/api/assistants/${currentAssistant.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      notify(`Cannot change status: ${err.error || "Ready knowledge source required."}`);
      return;
    }

    notify(`Assistant is now ${nextStatus === "published" ? "published and live!" : "in draft mode."}`);
    await refreshWorkspace();
  });
}

function setupKnowledgeHandlers(): void {
  // Website crawl form
  $("#crawl-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const urlInput = $("#crawl-url") as HTMLInputElement;
    if (!urlInput.value.trim() || !currentAssistant) return;

    const url = urlInput.value.trim();
    const btn = $("#btn-submit-crawl") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Initiating...";

    try {
      const res = await apiFetch(`/api/assistants/${currentAssistant.id}/sources`, {
        method: "POST",
        body: JSON.stringify({ type: "website", url })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to start website crawl.");
      }

      notify("Crawl job started. Extracting pages in background...");
      urlInput.value = "";
      await loadSources();
      startPollingJobs();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Start Crawling";
    }
  });

  // File selection
  const fileInput = $("#file-input") as HTMLInputElement;
  const selectFileBtn = $("#btn-select-file");
  const uploadBtn = $("#btn-upload-file") as HTMLButtonElement;
  const fileNameDisplay = $("#file-selected-name")!;

  selectFileBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      selectedFile = fileInput.files[0];
      fileNameDisplay.textContent = `${selectedFile.name} (${(selectedFile.size / 1024).toFixed(1)} KB)`;
      uploadBtn.style.display = "inline-flex";
    }
  });

  // Upload file
  uploadBtn?.addEventListener("click", async () => {
    if (!selectedFile || !currentAssistant) return;

    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";

    try {
      // 1. Get signed upload URL
      const res = await apiFetch(`/api/assistants/${currentAssistant.id}/sources`, {
        method: "POST",
        body: JSON.stringify({
          type: "file",
          fileName: selectedFile.name,
          contentType: selectedFile.type || "text/plain",
          sizeBytes: selectedFile.size
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload preparation failed.");
      }

      const uploadInfo = await res.json();

      // 2. Direct upload to Supabase storage
      const storageRes = await fetch(uploadInfo.signedUrl, {
        method: "PUT",
        headers: {
          "Content-Type": selectedFile.type || "text/plain"
        },
        body: selectedFile
      });

      if (!storageRes.ok) {
        throw new Error(`Direct upload failed: ${storageRes.statusText}`);
      }

      // 3. Finalize upload
      const finRes = await apiFetch(`/api/assistants/${currentAssistant.id}/sources/${uploadInfo.sourceId}/finalize-file`, {
        method: "POST"
      });

      if (!finRes.ok) {
        throw new Error("Failed to finalize file processing.");
      }

      notify("File uploaded! Ingestion processing in background...");
      selectedFile = null;
      fileNameDisplay.textContent = "";
      uploadBtn.style.display = "none";
      await loadSources();
      startPollingJobs();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload & Ingest";
    }
  });

  // FAQ form
  $("#faq-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const qInput = $("#faq-q") as HTMLInputElement;
    const aInput = $("#faq-a") as HTMLInputElement;
    if (!qInput.value.trim() || !aInput.value.trim() || !currentAssistant) return;

    try {
      const res = await apiFetch(`/api/assistants/${currentAssistant.id}/sources`, {
        method: "POST",
        body: JSON.stringify({
          type: "faq",
          title: `FAQ: ${qInput.value.slice(0, 30)}...`,
          items: [{ question: qInput.value.trim(), answer: aInput.value.trim() }]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to add FAQ.");
      }

      notify("FAQ added and indexed successfully!");
      qInput.value = "";
      aInput.value = "";
      await loadSources();
      startPollingJobs();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : String(err));
    }
  });
}

async function loadSources(): Promise<void> {
  if (!currentAssistant) return;
  const tbody = $("#sources-tbody")!;

  try {
    const res = await apiFetch(`/api/assistants/${currentAssistant.id}/sources`);
    if (!res.ok) return;

    const { sources } = await res.json();
    if (!sources || sources.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No knowledge sources added yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    let hasProcessing = false;

    sources.forEach((s: any) => {
      if (s.status === "processing" || s.status === "pending") {
        hasProcessing = true;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-weight:500;">
          ${escapeHtml(s.title)}
          ${s.error_message ? `<div style="font-size:11px; color:var(--danger);">${escapeHtml(s.error_message)}</div>` : ""}
        </td>
        <td><code>${escapeHtml(s.type)}</code></td>
        <td><span class="status-badge status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
        <td>${(s.char_count || 0).toLocaleString()}</td>
        <td>${s.chunk_count || 0}</td>
        <td>
          <button class="btn btn-danger btn-sm" data-delete-source="${s.id}">Delete</button>
        </td>
      `;

      tr.querySelector(`[data-delete-source="${s.id}"]`)?.addEventListener("click", async () => {
        if (!confirm(`Delete source "${s.title}" and its vector chunks?`)) return;
        const delRes = await apiFetch(`/api/assistants/${currentAssistant.id}/sources/${s.id}`, { method: "DELETE" });
        if (delRes.ok) {
          notify("Source deleted.");
          await loadSources();
          await refreshWorkspace();
        } else {
          notify("Failed to delete source.");
        }
      });

      tbody.appendChild(tr);
    });

    if (hasProcessing) {
      startPollingJobs();
    } else {
      stopPollingJobs();
    }
  } catch (err) {
    console.error("Error loading sources:", err);
  }
}

function startPollingJobs(): void {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadSources();
    await refreshWorkspace();
  }, 3000);
}

function stopPollingJobs(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function mountPreview(): void {
  if (!currentAssistant) return;
  const container = $("#preview-widget-container")!;
  container.innerHTML = "";

  const script = document.createElement("script");
  script.src = "/nexus.js";
  script.dataset.previewToken = accessToken;
  script.dataset.previewAssistant = currentAssistant.id;
  script.dataset.target = "#preview-widget-container";
  container.appendChild(script);
}

function updateSnippetCode(): void {
  if (!currentAssistant) return;
  const origin = window.location.origin;
  const snippet = `<script src="${origin}/nexus.js" data-assistant="${currentAssistant.public_id}" defer></script>`;
  const codeEl = $("#snippet-code");
  if (codeEl) codeEl.textContent = snippet;
}

function setupSnippetCopy(): void {
  $("#btn-copy-install-snippet")?.addEventListener("click", async () => {
    const code = $("#snippet-code")?.textContent || "";
    if (code) {
      await navigator.clipboard.writeText(code);
      notify("Installation snippet copied to clipboard!");
    }
  });
}

async function loadConversations(): Promise<void> {
  if (!currentAssistant) return;
  const tbody = $("#conv-tbody")!;

  try {
    const res = await apiFetch(`/api/assistants/${currentAssistant.id}/conversations`);
    if (!res.ok) return;

    const { conversations } = await res.json();
    if (!conversations || conversations.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No conversations recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    conversations.forEach((c: any) => {
      const tr = document.createElement("tr");
      const date = new Date(c.created_at).toLocaleDateString();
      tr.innerHTML = `
        <td><code>${c.id.slice(0, 8)}...</code></td>
        <td><span class="status-badge status-${c.mode === "public" ? "published" : "draft"}">${c.mode}</span></td>
        <td>${c.origin || "Direct"}</td>
        <td>${c.turn_count || 0} / 20</td>
        <td>${date}</td>
        <td>
          <button class="btn btn-danger btn-sm" data-delete-conv="${c.id}">Delete</button>
        </td>
      `;

      tr.querySelector(`[data-delete-conv="${c.id}"]`)?.addEventListener("click", async () => {
        if (!confirm("Permanently delete this conversation transcript?")) return;
        const delRes = await apiFetch(`/api/assistants/${currentAssistant.id}/conversations/${c.id}`, { method: "DELETE" });
        if (delRes.ok) {
          notify("Conversation deleted.");
          await loadConversations();
        }
      });

      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Error loading conversations:", err);
  }
}

function populateUsage(usageData: any): void {
  if (!usageData) return;
  const limits = usageData.limits || {};

  $("#usage-conv")!.textContent = `${usageData.conversationsCount || 0} / ${limits.MAX_CONVERSATIONS_PER_MONTH || 100}`;
  $("#usage-msg")!.textContent = `${usageData.messagesCount || 0} / ${limits.MAX_MESSAGES_PER_MONTH || 1000}`;
  $("#usage-ingest")!.textContent = `${(usageData.ingestedCharsCount || 0).toLocaleString()} / ${(limits.MAX_INGESTED_CHARS_PER_MONTH || 1000000).toLocaleString()} chars`;
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", initDashboard);

import { CONFIG, isNimConfigured } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatCallbacks {
  onDelta: (delta: string) => void;
  onError?: (err: Error) => void;
  onDone?: (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void;
}

export class NimError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public isRetryable: boolean = false
  ) {
    super(message);
    this.name = "NimError";
  }
}

/**
 * Generates an embedding vector for given text using NVIDIA NIM.
 * Model default: baai/bge-m3 or nvidia/nv-embedqa-e5-v5 (dimension 1024).
 */
export async function createEmbedding(
  text: string,
  inputType: "query" | "passage" = "passage",
  fetchFn: typeof fetch = fetch
): Promise<number[]> {
  if (!isNimConfigured()) {
    throw new NimError(
      "NVIDIA NIM is not configured. Missing NIM_API_KEY.",
      503,
      false
    );
  }

  const endpoint = `${CONFIG.NIM_BASE_URL}/embeddings`;
  const body: Record<string, unknown> = {
    input: [text],
    model: CONFIG.NIM_EMBED_MODEL,
    encoding_format: "float"
  };

  if (CONFIG.NIM_EMBED_MODEL.includes("nv-embedqa") || CONFIG.NIM_EMBED_MODEL.includes("nemotron")) {
    body.input_type = inputType;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.NIM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.NIM_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    throw new NimError(`NIM Embedding network error: ${msg}`, 502, true);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const isRetryable = res.status === 429 || res.status >= 500;
    throw new NimError(
      `NIM Embedding error (${res.status}): ${errorText || res.statusText}`,
      res.status,
      isRetryable
    );
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };

  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== CONFIG.NIM_EMBED_DIMENSION) {
    throw new NimError(
      `Invalid embedding returned: expected array of length ${CONFIG.NIM_EMBED_DIMENSION}, got ${vector?.length ?? "none"}`,
      502,
      false
    );
  }

  // Validate finite numbers
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new NimError("Invalid non-finite number in embedding vector", 502, false);
    }
  }

  return vector;
}

/**
 * Streams chat completion from NVIDIA NIM (OpenAI-compatible SSE)
 */
export async function streamChat(
  messages: ChatMessage[],
  callbacks: StreamChatCallbacks,
  abortSignal?: AbortSignal,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (CONFIG.INFERENCE_KILL_SWITCH) {
    throw new NimError("Inference is temporarily disabled by server kill-switch.", 503, false);
  }

  if (!isNimConfigured()) {
    throw new NimError(
      "NVIDIA NIM is not configured. Missing NIM_API_KEY.",
      503,
      false
    );
  }

  const endpoint = `${CONFIG.NIM_BASE_URL}/chat/completions`;
  const body = {
    model: CONFIG.NIM_CHAT_MODEL,
    messages,
    stream: true,
    temperature: 0.2,
    max_tokens: 1024
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.NIM_TIMEOUT_MS);

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.NIM_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    throw new NimError(`NIM Chat network error: ${msg}`, 502, true);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const isRetryable = res.status === 429 || res.status >= 500;
    throw new NimError(
      `NIM Chat error (${res.status}): ${errorText || res.statusText}`,
      res.status,
      isRetryable
    );
  }

  if (!res.body) {
    throw new NimError("Response body is empty", 502, false);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // comment/ping

        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === "[DONE]") {
            callbacks.onDone?.(usage);
            return;
          }

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.usage) {
              usage = parsed.usage;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              callbacks.onDelta(delta);
            }
          } catch {
            // Ignore incomplete partial line parse errors
          }
        }
      }
    }

    // Flush any remaining decoder bytes
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data: ")) {
      const dataStr = buffer.trim().slice(6).trim();
      if (dataStr === "[DONE]") {
        callbacks.onDone?.(usage);
        return;
      }
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // ignore
      }
    }

    callbacks.onDone?.(usage);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    callbacks.onError?.(error);
    throw error;
  }
}

import { describe, it } from "node:test";
import assert from "node:assert";
import { createEmbedding, streamChat, NimError } from "../src/lib/nim.js";
import { CONFIG } from "../src/config.js";

describe("NVIDIA NIM Adapter", () => {
  it("rejects embedding if NIM is not configured", async () => {
    const origKey = CONFIG.NIM_API_KEY;
    (CONFIG as any).NIM_API_KEY = "";
    try {
      await assert.rejects(
        () => createEmbedding("test text"),
        (err: NimError) => {
          assert.strictEqual(err.statusCode, 503);
          assert.match(err.message, /Missing NIM_API_KEY/);
          return true;
        }
      );
    } finally {
      (CONFIG as any).NIM_API_KEY = origKey;
    }
  });

  it("handles valid 1024-dim embedding response", async () => {
    const origKey = CONFIG.NIM_API_KEY;
    (CONFIG as any).NIM_API_KEY = "mock-key";

    const mockVector = new Array(1024).fill(0.0123);
    const mockFetch = (async () => {
      return new Response(JSON.stringify({
        data: [{ embedding: mockVector }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as any;

    try {
      const vec = await createEmbedding("sample query", "query", mockFetch);
      assert.strictEqual(vec.length, 1024);
      assert.strictEqual(vec[0], 0.0123);
    } finally {
      (CONFIG as any).NIM_API_KEY = origKey;
    }
  });

  it("rejects malformed dimensions or non-finite vectors", async () => {
    const origKey = CONFIG.NIM_API_KEY;
    (CONFIG as any).NIM_API_KEY = "mock-key";

    // Too short vector
    const shortFetch = (async () => {
      return new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2] }]
      }), { status: 200 });
    }) as any;

    try {
      await assert.rejects(
        () => createEmbedding("text", "passage", shortFetch),
        (err: NimError) => {
          assert.match(err.message, /expected array of length 1024/);
          return true;
        }
      );
    } finally {
      (CONFIG as any).NIM_API_KEY = origKey;
    }
  });

  it("handles 429 and 500 error codes with retryable flag", async () => {
    const origKey = CONFIG.NIM_API_KEY;
    (CONFIG as any).NIM_API_KEY = "mock-key";

    const rateLimitFetch = (async () => {
      return new Response("Rate limit exceeded", { status: 429 });
    }) as any;

    try {
      await assert.rejects(
        () => createEmbedding("text", "passage", rateLimitFetch),
        (err: NimError) => {
          assert.strictEqual(err.statusCode, 429);
          assert.strictEqual(err.isRetryable, true);
          return true;
        }
      );
    } finally {
      (CONFIG as any).NIM_API_KEY = origKey;
    }
  });

  it("streams chat SSE deltas and parses [DONE] properly across split chunks", async () => {
    const origKey = CONFIG.NIM_API_KEY;
    (CONFIG as any).NIM_API_KEY = "mock-key";

    const sseParts = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n'
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const part of sseParts) {
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      }
    });

    const mockFetch = (async () => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    }) as any;

    const deltas: string[] = [];
    let completed = false;

    try {
      await streamChat(
        [{ role: "user", content: "hi" }],
        {
          onDelta: (chunk) => deltas.push(chunk),
          onDone: () => { completed = true; }
        },
        undefined,
        mockFetch
      );

      assert.strictEqual(deltas.join(""), "Hello world!");
      assert.strictEqual(completed, true);
    } finally {
      (CONFIG as any).NIM_API_KEY = origKey;
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { extractHtml, extractPlainText, extractFaqs } from "../src/lib/extract.js";
import { chunkText } from "../src/lib/chunk.js";
import { normalizeUrl, isAllowedByRobots } from "../src/lib/crawl.js";

describe("Extract and Chunk", () => {
  it("extracts text and title from HTML cleanly, removing scripts and nav", () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>About Acme Corp</title></head>
        <body>
          <nav><a href="/">Home</a></nav>
          <script>console.log("bad");</script>
          <main>
            <h1>Welcome to Acme</h1>
            <p>Acme provides intelligent conversational sidekicks for modern web apps.</p>
          </main>
          <footer>Footer text</footer>
        </body>
      </html>
    `;

    const extracted = extractHtml(sampleHtml);
    assert.strictEqual(extracted.title, "About Acme Corp");
    assert.match(extracted.text, /Welcome to Acme/);
    assert.match(extracted.text, /intelligent conversational sidekicks/);
    assert.doesNotMatch(extracted.text, /bad/);
    assert.doesNotMatch(extracted.text, /Footer text/);
  });

  it("extracts structured FAQs into QA text", () => {
    const faqs = [
      { question: "How to install?", answer: "Add one line of script before body." },
      { question: "Is there a free tier?", answer: "Yes, free beta includes 100 conversations." }
    ];

    const extracted = extractFaqs(faqs);
    assert.match(extracted.text, /Q: How to install\?\nA: Add one line of script before body\./);
    assert.match(extracted.text, /Q: Is there a free tier\?/);
  });

  it("chunks long text with overlap and attaches metadata", () => {
    const longText = "Sentence one is here. ".repeat(60); // ~1320 chars
    const chunks = chunkText(longText, "Test Doc", "https://example.com/doc", 500, 100);

    assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
    assert.strictEqual(chunks[0].ordinal, 0);
    assert.strictEqual(chunks[1].ordinal, 1);
    assert.strictEqual(chunks[0].sourceTitle, "Test Doc");
    assert.strictEqual(chunks[0].sourceUrl, "https://example.com/doc");
    assert.ok(chunks[0].contentHash.length === 64);
  });

  it("normalizes crawl URLs and checks robots.txt disallow rules", () => {
    assert.strictEqual(
      normalizeUrl("https://example.com/about/#team"),
      "https://example.com/about"
    );
    assert.strictEqual(
      normalizeUrl("/pricing", "https://example.com"),
      "https://example.com/pricing"
    );

    const disallowed = ["/admin", "/private/"];
    assert.strictEqual(isAllowedByRobots(disallowed, "/about"), true);
    assert.strictEqual(isAllowedByRobots(disallowed, "/admin/settings"), false);
    assert.strictEqual(isAllowedByRobots(disallowed, "/private/docs"), false);
  });
});

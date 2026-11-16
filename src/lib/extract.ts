import crypto from "node:crypto";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";

export interface ExtractedDocument {
  title: string;
  text: string;
  contentHash: string;
  charCount: number;
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Extracts clean text and metadata from HTML content using Cheerio.
 * Excludes scripts, styles, forms, and hidden elements.
 */
export function extractHtml(html: string, defaultTitle = "Webpage"): ExtractedDocument {
  const $ = cheerio.load(html);

  // Remove unwanted elements
  $("script, style, noscript, svg, nav, footer, iframe, form, button").remove();

  const title = $("title").first().text().trim() ||
                $("h1").first().text().trim() ||
                defaultTitle;

  // Extract text from main or body
  const root = $("main").length > 0 ? $("main") : $("body");
  const rawText = root.text() || $("body").text();
  const text = cleanText(rawText);

  if (!text || text.length < 10) {
    throw new Error("No useful text content found in HTML (page may rely on client-side JavaScript or be empty).");
  }

  return {
    title,
    text,
    contentHash: computeSha256(text),
    charCount: text.length
  };
}

/**
 * Extracts text from plain text or markdown files.
 */
export function extractPlainText(raw: string, title = "Document"): ExtractedDocument {
  const text = cleanText(raw);
  if (!text) {
    throw new Error("Document is empty.");
  }

  return {
    title,
    text,
    contentHash: computeSha256(text),
    charCount: text.length
  };
}

/**
 * Extracts text from PDF buffer using pdf-parse.
 */
export async function extractPdf(pdfBuffer: Buffer, title = "PDF Document"): Promise<ExtractedDocument> {
  let parsed;
  try {
    parsed = await pdfParse(pdfBuffer);
  } catch (err: unknown) {
    throw new Error(`Failed to parse PDF document: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = cleanText(parsed.text);
  if (!text || text.length < 10) {
    throw new Error("PDF contains no extractable text. Scanned or image-only PDFs are not supported in this beta.");
  }

  const metaTitle = parsed.info?.Title ? String(parsed.info.Title).trim() : "";

  return {
    title: metaTitle || title,
    text,
    contentHash: computeSha256(text),
    charCount: text.length
  };
}

/**
 * Extracts text from structured FAQ items.
 */
export function extractFaqs(
  items: Array<{ question: string; answer: string }>,
  title = "Frequently Asked Questions"
): ExtractedDocument {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("FAQ list must contain at least one question and answer.");
  }

  const sections: string[] = [];
  for (const item of items) {
    const q = item.question?.trim();
    const a = item.answer?.trim();
    if (q && a) {
      sections.push(`Q: ${q}\nA: ${a}`);
    }
  }

  if (sections.length === 0) {
    throw new Error("No valid FAQ pairs found.");
  }

  const text = sections.join("\n\n");
  return {
    title,
    text,
    contentHash: computeSha256(text),
    charCount: text.length
  };
}

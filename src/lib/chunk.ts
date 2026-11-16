import { CONFIG } from "../config.js";
import { computeSha256 } from "./extract.js";

export interface TextChunk {
  ordinal: number;
  content: string;
  sourceTitle: string;
  sourceUrl?: string;
  tokenEstimate: number;
  contentHash: string;
}

/**
 * Splits normalized text into overlapping chunks respecting sentence and paragraph boundaries.
 */
export function chunkText(
  text: string,
  sourceTitle: string,
  sourceUrl?: string,
  chunkSize: number = CONFIG.LIMITS.CHUNK_SIZE_CHARS,
  chunkOverlap: number = CONFIG.LIMITS.CHUNK_OVERLAP_CHARS
): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  const chunks: TextChunk[] = [];
  let startIndex = 0;
  let ordinal = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;

    if (endIndex < text.length) {
      // Look back for a natural boundary (paragraph break, sentence end, or newline)
      const lookbackWindow = text.slice(Math.max(startIndex, endIndex - 150), endIndex);
      const boundaryMatch = lookbackWindow.search(/(\.\s+|\n\n|\n)[^\n]*$/);

      if (boundaryMatch !== -1) {
        endIndex = Math.max(startIndex, endIndex - 150) + boundaryMatch + 1;
      }
    } else {
      endIndex = text.length;
    }

    const chunkContent = text.slice(startIndex, endIndex).trim();

    if (chunkContent.length > 0) {
      // Rough token estimate: ~4 chars per token
      const tokenEstimate = Math.ceil(chunkContent.length / 4);

      chunks.push({
        ordinal: ordinal++,
        content: chunkContent,
        sourceTitle,
        sourceUrl,
        tokenEstimate,
        contentHash: computeSha256(chunkContent)
      });
    }

    if (endIndex >= text.length) break;

    // Advance with overlap
    startIndex = Math.max(startIndex + 1, endIndex - chunkOverlap);
  }

  return chunks;
}

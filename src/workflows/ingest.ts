import { getAdminClient } from "../lib/supabase.js";
import { crawlWebsite } from "../lib/crawl.js";
import { extractPlainText, extractPdf, extractFaqs } from "../lib/extract.js";
import { chunkText, TextChunk } from "../lib/chunk.js";
import { createEmbedding } from "../lib/nim.js";
import { assertIngestionCaps, getCurrentYearMonth } from "../lib/limits.js";

export interface JobRunResult {
  jobId: string;
  status: "completed" | "failed";
  error?: string;
  totalChars?: number;
  totalChunks?: number;
}

/**
 * Executes a durable ingestion job for an assistant source.
 */
export async function runIngestionJob(jobId: string): Promise<JobRunResult> {
  const supabase = getAdminClient();

  // 1. Fetch job record
  const { data: job, error: jobErr } = await supabase
    .from("ingestion_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    throw new Error(`Ingestion job ${jobId} not found: ${jobErr?.message}`);
  }

  // 2. Fetch source record
  const { data: source, error: srcErr } = await supabase
    .from("sources")
    .select("*")
    .eq("id", job.source_id)
    .maybeSingle();

  if (srcErr || !source) {
    await supabase.from("ingestion_jobs").update({
      status: "failed",
      error_message: "Source was deleted before processing started."
    }).eq("id", jobId);
    return { jobId, status: "failed", error: "Source not found" };
  }

  // Mark job and source as processing
  await supabase.from("ingestion_jobs").update({ status: "processing", progress: 10 }).eq("id", jobId);
  await supabase.from("sources").update({ status: "processing", error_message: null }).eq("id", source.id);

  const targetGeneration = (source.active_generation || 1) + 1;

  try {
    const allChunks: TextChunk[] = [];
    let totalChars = 0;

    // 3. Extract content based on source type
    if (source.type === "website") {
      const crawlResult = await crawlWebsite(source.location);
      if (crawlResult.pages.length === 0) {
        throw new Error("No readable pages could be crawled from the specified website.");
      }

      for (const page of crawlResult.pages) {
        const pageChunks = chunkText(page.text, page.title || source.title, page.url);
        allChunks.push(...pageChunks);
        totalChars += page.charCount;
      }
    } else if (source.type === "text") {
      const extracted = extractPlainText(source.location || "", source.title);
      totalChars = extracted.charCount;
      allChunks.push(...chunkText(extracted.text, extracted.title));
    } else if (source.type === "faq") {
      let items = [];
      try {
        items = JSON.parse(source.location || "[]");
      } catch {
        throw new Error("Invalid FAQ items payload.");
      }
      const extracted = extractFaqs(items, source.title);
      totalChars = extracted.charCount;
      allChunks.push(...chunkText(extracted.text, extracted.title));
    } else if (source.type === "file") {
      // Download private file from storage bucket
      const { data: fileData, error: fileErr } = await supabase.storage
        .from("knowledge-files")
        .download(source.storage_path);

      if (fileErr || !fileData) {
        throw new Error(`Failed to download stored file: ${fileErr?.message}`);
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      if (source.storage_path.endsWith(".pdf")) {
        const extracted = await extractPdf(buffer, source.title);
        totalChars = extracted.charCount;
        allChunks.push(...chunkText(extracted.text, extracted.title));
      } else {
        const extracted = extractPlainText(buffer.toString("utf-8"), source.title);
        totalChars = extracted.charCount;
        allChunks.push(...chunkText(extracted.text, extracted.title));
      }
    }

    if (allChunks.length === 0) {
      throw new Error("No extractable text chunks could be produced from this source.");
    }

    // 4. Enforce caps before calling NIM
    await assertIngestionCaps(supabase, source.assistant_id, source.workspace_id, {
      newChars: totalChars,
      newChunks: allChunks.length,
      isFile: source.type === "file",
      isPage: source.type === "website"
    });

    await supabase.from("ingestion_jobs").update({ progress: 40 }).eq("id", jobId);

    // 5. Generate embeddings and prepare rows
    const chunkRows = [];
    for (let i = 0; i < allChunks.length; i++) {
      // Check if source was deleted mid-process
      const { data: checkSource } = await supabase
        .from("sources")
        .select("id")
        .eq("id", source.id)
        .maybeSingle();

      if (!checkSource) {
        // Source was deleted by user while job was running
        await supabase.from("chunks").delete().eq("source_id", source.id);
        return { jobId, status: "failed", error: "Source deleted during processing." };
      }

      const chunk = allChunks[i];
      const embedding = await createEmbedding(chunk.content, "passage");

      chunkRows.push({
        workspace_id: source.workspace_id,
        assistant_id: source.assistant_id,
        source_id: source.id,
        generation: targetGeneration,
        ordinal: chunk.ordinal,
        content: chunk.content,
        source_title: chunk.sourceTitle,
        source_url: chunk.sourceUrl || null,
        token_count: chunk.tokenEstimate,
        embedding: embedding,
        content_hash: chunk.contentHash
      });

      // Update progress proportionally
      if (i % 5 === 0) {
        const pct = 40 + Math.floor((i / allChunks.length) * 50);
        await supabase.from("ingestion_jobs").update({ progress: pct }).eq("id", jobId);
      }
    }

    // 6. Insert new generation chunks
    const { error: insertErr } = await supabase.from("chunks").insert(chunkRows);
    if (insertErr) {
      throw new Error(`Failed to persist vector chunks: ${insertErr.message}`);
    }

    // 7. Atomic publish: update source active generation and ready status
    await supabase.from("sources").update({
      status: "ready",
      active_generation: targetGeneration,
      char_count: totalChars,
      chunk_count: allChunks.length,
      error_message: null
    }).eq("id", source.id);

    // 8. Delete obsolete old generation chunks
    await supabase.from("chunks")
      .delete()
      .eq("source_id", source.id)
      .lt("generation", targetGeneration);

    // 9. Record monthly ingested chars in usage_periods
    await supabase.rpc("increment_monthly_usage", {
      target_workspace_id: source.workspace_id,
      target_year_month: getCurrentYearMonth(),
      delta_conversations: 0,
      delta_messages: 0,
      delta_ingested_chars: totalChars
    });

    // 10. Mark job completed
    await supabase.from("ingestion_jobs").update({
      status: "completed",
      progress: 100,
      extracted_chars: totalChars,
      chunks_created: allChunks.length,
      error_message: null
    }).eq("id", jobId);

    return {
      jobId,
      status: "completed",
      totalChars,
      totalChunks: allChunks.length
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Clean up any uncompleted targetGeneration chunks
    await supabase.from("chunks")
      .delete()
      .eq("source_id", source.id)
      .eq("generation", targetGeneration);

    // If source had a previous ready generation, keep it ready with warning
    const revertStatus = source.char_count > 0 ? "ready" : "failed";
    await supabase.from("sources").update({
      status: revertStatus,
      error_message: errorMsg
    }).eq("id", source.id);

    await supabase.from("ingestion_jobs").update({
      status: "failed",
      error_message: errorMsg
    }).eq("id", jobId);

    return { jobId, status: "failed", error: errorMsg };
  }
}

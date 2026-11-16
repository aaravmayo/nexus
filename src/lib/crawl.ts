import * as cheerio from "cheerio";
import { safeFetch } from "./ssrf.js";
import { extractHtml } from "./extract.js";
import { CONFIG } from "../config.js";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  charCount: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  totalChars: number;
  errors: Array<{ url: string; error: string }>;
}

/**
 * Normalizes URL string, removes hash fragments and trailing slashes.
 */
export function normalizeUrl(raw: string, baseUrl?: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = ""; // Strip query params to avoid infinite pagination crawl traps
    let href = url.toString();
    if (href.endsWith("/") && url.pathname !== "/") {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

/**
 * Checks if path is disallowed by robots.txt lines for generic user agents.
 */
export function isAllowedByRobots(disallowedPaths: string[], pathname: string): boolean {
  for (const dis of disallowedPaths) {
    if (!dis || dis === "") continue;
    if (dis === "/") return false;
    if (pathname.startsWith(dis)) return false;
  }
  return true;
}

/**
 * Crawls bounded public pages from origin starting at startUrl.
 */
export async function crawlWebsite(
  startUrlString: string,
  maxPages = CONFIG.LIMITS.MAX_ACTIVE_WEBSITE_PAGES,
  maxChars = CONFIG.LIMITS.MAX_ACTIVE_EXTRACTED_CHARS
): Promise<CrawlResult> {
  const startUrl = normalizeUrl(startUrlString);
  if (!startUrl) {
    throw new Error(`Invalid start URL: ${startUrlString}`);
  }

  const baseOrigin = new URL(startUrl).origin;
  const disallowedPaths: string[] = [];

  // 1. Fetch robots.txt if available
  try {
    const robotsUrl = `${baseOrigin}/robots.txt`;
    const res = await safeFetch(robotsUrl, { headers: { "User-Agent": "NexusBot/1.0" } });
    if (res.ok) {
      const robotsText = await res.text();
      const lines = robotsText.split("\n");
      let appliesToAll = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^User-agent:\s*\*/i.test(trimmed)) {
          appliesToAll = true;
        } else if (/^User-agent:/i.test(trimmed)) {
          appliesToAll = false;
        } else if (appliesToAll && /^Disallow:\s*(.*)/i.test(trimmed)) {
          const match = trimmed.match(/^Disallow:\s*(.*)/i);
          if (match && match[1]) {
            disallowedPaths.push(match[1].trim());
          }
        }
      }
    }
  } catch {
    // If robots.txt fetch fails, proceed with crawl
  }

  const queue: string[] = [startUrl];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  let totalChars = 0;

  while (queue.length > 0 && pages.length < maxPages && totalChars < maxChars) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const parsed = new URL(currentUrl);
    if (!isAllowedByRobots(disallowedPaths, parsed.pathname)) {
      continue;
    }

    try {
      const res = await safeFetch(currentUrl, {
        headers: {
          "User-Agent": "NexusBot/1.0 (MVP beta crawler)",
          "Accept": "text/html"
        }
      });

      if (!res.ok) {
        errors.push({ url: currentUrl, error: `HTTP ${res.status}` });
        continue;
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        // Skip non-HTML content
        continue;
      }

      const html = await res.text();
      const extracted = extractHtml(html, parsed.pathname);

      if (totalChars + extracted.charCount > maxChars) {
        // Truncate if exceeds limit
        const remainingChars = maxChars - totalChars;
        if (remainingChars > 100) {
          pages.push({
            url: currentUrl,
            title: extracted.title,
            text: extracted.text.slice(0, remainingChars),
            charCount: remainingChars
          });
          totalChars += remainingChars;
        }
        break;
      }

      pages.push({
        url: currentUrl,
        title: extracted.title,
        text: extracted.text,
        charCount: extracted.charCount
      });
      totalChars += extracted.charCount;

      // Find links on page for subsequent crawling
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const normalized = normalizeUrl(href, currentUrl);
        if (
          normalized &&
          new URL(normalized).origin === baseOrigin &&
          !visited.has(normalized) &&
          !queue.includes(normalized) &&
          queue.length + pages.length < maxPages * 2
        ) {
          queue.push(normalized);
        }
      });
    } catch (err: unknown) {
      errors.push({
        url: currentUrl,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    pages,
    totalChars,
    errors
  };
}

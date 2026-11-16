import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Checks if an IP address string is private, loopback, link-local, cloud metadata, or reserved.
 */
export function isBlockedIp(ipString: string): boolean {
  try {
    let addr = ipaddr.parse(ipString);

    // Normalize IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
    if (addr.kind() === "ipv6") {
      const ipv6 = addr as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        addr = ipv6.toIPv4Address();
      }
    }

    const range = addr.range();
    const blockedRanges = [
      "loopback",
      "private",
      "linkLocal",
      "broadcast",
      "carrierGradeNat",
      "uniqueLocal",
      "unspecified",
      "reserved"
    ];

    if (blockedRanges.includes(range)) {
      return true;
    }

    // Explicit check for cloud metadata addresses
    const str = addr.toString();
    if (str === "169.254.169.254" || str === "100.100.100.200") {
      return true;
    }

    return false;
  } catch {
    return true; // If IP cannot be parsed, reject for safety
  }
}

/**
 * Validates target URL against SSRF rules:
 * - Scheme must be http or https
 * - Disallowed metadata hostnames
 * - Resolves DNS and verifies all IPs are public
 */
export async function validateUrlForSsrf(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new SsrfError(`Invalid URL: ${urlString}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported protocol '${url.protocol}'. Only http: and https: are allowed.`);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw new SsrfError(`Hostname '${hostname}' is prohibited.`);
  }

  // Resolve DNS to verify all returned IPs
  try {
    const lookups = await dns.lookup(hostname, { all: true });
    if (!lookups || lookups.length === 0) {
      throw new SsrfError(`Unable to resolve hostname '${hostname}'.`);
    }

    for (const record of lookups) {
      if (isBlockedIp(record.address)) {
        throw new SsrfError(`Access to blocked IP address '${record.address}' for host '${hostname}' is denied.`);
      }
    }
  } catch (err: unknown) {
    if (err instanceof SsrfError) throw err;
    throw new SsrfError(`DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`);
  }

  return url;
}

/**
 * Safe fetch with manual redirect handling and SSRF validation on every redirect step.
 */
export async function safeFetch(
  urlString: string,
  options: RequestInit = {},
  maxRedirects = 5
): Promise<Response> {
  let currentUrl = urlString;
  let redirects = 0;

  while (redirects <= maxRedirects) {
    const validUrl = await validateUrlForSsrf(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(validUrl.toString(), {
        ...options,
        redirect: "manual",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    // Check for redirect status
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new SsrfError(`Redirect without Location header from ${currentUrl}`);
      }
      currentUrl = new URL(location, validUrl).toString();
      redirects++;
      continue;
    }

    return res;
  }

  throw new SsrfError(`Too many redirects (exceeded limit of ${maxRedirects})`);
}

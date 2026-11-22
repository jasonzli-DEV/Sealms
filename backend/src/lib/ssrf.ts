import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    if (isIP(mapped) === 4) {
      return isPrivateIpv4(mapped);
    }
  }
  // fc00::/7 Unique local address
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 Link-local
  if (/^fe[89ab]/.test(lower)) return true;
  // ff00::/8 Multicast
  if (lower.startsWith("ff")) return true;
  return false;
}

export interface ValidateUrlOptions {
  allowInsecureLocal?: boolean;
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string }>>;
}

export async function validatePanelUrl(
  rawUrl: string,
  options: ValidateUrlOptions = {}
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SsrfError("Invalid panel URL format");
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError("Panel URL must not contain embedded credentials");
  }

  if (!options.allowInsecureLocal) {
    if (parsed.protocol !== "https:") {
      throw new SsrfError("Panel URL must use https://");
    }
  } else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfError("Panel URL must use http:// or https://");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfError("Panel URL must include a hostname");
  }

  if (!options.allowInsecureLocal) {
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      throw new SsrfError("Panel URL cannot point to local or internal hostnames");
    }

    if (isIP(hostname) !== 0) {
      if (isPrivateIp(hostname)) {
        throw new SsrfError("Panel URL cannot point to a private or loopback IP address");
      }
      return parsed;
    }

    const resolver = options.dnsLookup ?? ((h: string) => lookup(h, { all: true }));
    let records: Array<{ address: string }>;
    try {
      records = await resolver(hostname);
    } catch {
      throw new SsrfError(`Unable to resolve panel hostname: ${hostname}`);
    }
    if (!records.length) {
      throw new SsrfError(`No DNS records found for panel hostname: ${hostname}`);
    }
    for (const rec of records) {
      if (isPrivateIp(rec.address)) {
        throw new SsrfError("Panel URL resolved to a private or restricted IP address");
      }
    }
  }

  return parsed;
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: ValidateUrlOptions & { maxRedirects?: number; fetchImpl?: typeof fetch } = {}
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 3;
  const fetchFn = options.fetchImpl ?? fetch;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await validatePanelUrl(currentUrl, options);
    const res = await fetchFn(currentUrl, {
      ...init,
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return res;
      }
      if (hop === maxRedirects) {
        throw new SsrfError("Too many redirects from panel URL");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new SsrfError("Exceeded redirect limit");
}

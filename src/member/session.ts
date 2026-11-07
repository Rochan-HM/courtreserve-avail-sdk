import { readFileSync } from "node:fs";
import { SessionMissingError } from "../errors.js";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function sessionPathFromEnv(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return env.COURTRESERVE_SESSION_FILE || `${cwd}/.courtreserve-session.json`;
}

export function loadSessionFile(path: string): StoredCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new SessionMissingError();
  }
  const cookies = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)
    ? (parsed as { cookies: unknown[] }).cookies
    : null;
  if (!cookies) throw new SessionMissingError();
  const stored: StoredCookie[] = [];
  for (const cookie of cookies) {
    const row = cookie as Partial<StoredCookie>;
    if (!row.name || !row.value || !row.domain) continue;
    stored.push({ name: row.name, value: row.value, domain: row.domain, path: row.path || "/" });
  }
  if (stored.length === 0) throw new SessionMissingError();
  return stored;
}

export function cookieHeader(cookies: readonly StoredCookie[], url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return cookies
    .filter((cookie) => domainMatches(cookie.domain, host))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function preferenceOrgId(cookies: readonly StoredCookie[]): string | null {
  const cookie = cookies.find((item) => item.name === "PreferenceOrgId");
  return cookie && /^\d+$/.test(cookie.value) ? cookie.value : null;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

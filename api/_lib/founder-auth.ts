/**
 * Founder dashboard password gate (server-only).
 * Password: FOUNDER_DASHBOARD_PASSWORD
 */
import { createHash, timingSafeEqual } from "crypto";

const COOKIE_NAME = "hsp_founder_session";

/** Web Request or Node IncomingMessage (Vercel Node runtime). */
type AnyRequest =
  | Request
  | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

function getHeader(request: AnyRequest, name: string): string | null {
  const lower = name.toLowerCase();
  const webHeaders = (request as Request).headers as Headers | undefined;
  if (webHeaders && typeof webHeaders.get === "function") {
    return webHeaders.get(name);
  }
  const nodeHeaders = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (!nodeHeaders) return null;
  const raw = nodeHeaders[lower];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

function password(): string {
  return (process.env.FOUNDER_DASHBOARD_PASSWORD ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n$/g, "")
    .replace(/\r?\n$/g, "");
}

function sessionToken(pwd: string): string {
  const salt = (process.env.FOUNDER_DASHBOARD_SALT ?? "hsp-founder-v1").trim();
  return createHash("sha256").update(`${salt}:${pwd}`).digest("hex");
}

export function founderPasswordConfigured(): boolean {
  return password().length >= 8;
}

export function verifyFounderPassword(candidate: string): boolean {
  const expected = password();
  if (!expected || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still run a compare to reduce timing leak on length.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function founderSessionCookieValue(): string | null {
  const pwd = password();
  if (!pwd) return null;
  return sessionToken(pwd);
}

export function verifyFounderSessionToken(token: string | null | undefined): boolean {
  const expected = founderSessionCookieValue();
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readFounderCookie(request: AnyRequest): string | null {
  const raw = getHeader(request, "cookie") ?? "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${COOKIE_NAME}=`)) {
      return decodeURIComponent(part.slice(COOKIE_NAME.length + 1));
    }
  }
  return null;
}

export function readFounderBearer(request: AnyRequest): string | null {
  const h = getHeader(request, "authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

export function isFounderAuthorized(request: AnyRequest): boolean {
  if (!founderPasswordConfigured()) return false;
  const bearer = readFounderBearer(request);
  if (bearer && (verifyFounderPassword(bearer) || verifyFounderSessionToken(bearer))) {
    return true;
  }
  return verifyFounderSessionToken(readFounderCookie(request));
}

export function buildFounderSessionSetCookie(): string {
  const token = founderSessionCookieValue() ?? "";
  const maxAge = 60 * 60 * 24 * 30;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function buildFounderSessionClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME as FOUNDER_COOKIE_NAME };

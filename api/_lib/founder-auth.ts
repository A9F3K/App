/**
 * Founder dashboard password gate (server-only).
 * Password: FOUNDER_DASHBOARD_PASSWORD
 */
import { createHash, timingSafeEqual } from "crypto";

const COOKIE_NAME = "hsp_founder_session";

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

export function readFounderCookie(request: Request): string | null {
  const raw = request.headers.get("cookie") ?? "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${COOKIE_NAME}=`)) {
      return decodeURIComponent(part.slice(COOKIE_NAME.length + 1));
    }
  }
  return null;
}

export function readFounderBearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

export function isFounderAuthorized(request: Request): boolean {
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

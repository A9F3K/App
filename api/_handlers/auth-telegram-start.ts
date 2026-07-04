import {
  buildTelegramAuthorizeUrl,
  randomUrlSafe,
  resolveTelegramBotId,
  sha256Base64Url,
  sha256Hex,
} from "../_lib/telegram-oidc.js";
import { appError, appLogEvent, appWarn } from "../../shared/appLog.js";
import { createEphemeralAttempt } from "../_lib/telegram-attempt-store.js";
import { createLoginAttempt } from "../../database/telegramAuth.js";
import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};
type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

function getHeader(request: AnyRequest, name: string): string | null {
  const lower = name.toLowerCase();
  const webHeaders = (request as Request).headers as Headers | undefined;
  if (webHeaders && typeof (webHeaders as Headers).get === "function") {
    return webHeaders.get(name);
  }
  const nodeHeaders = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (!nodeHeaders) return null;
  const raw = nodeHeaders[lower];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

function getRequestOrigin(request: AnyRequest): string {
  const rawUrl = (request as { url?: string }).url ?? "";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return new URL(rawUrl).origin;
  }
  const proto = getHeader(request, "x-forwarded-proto") || "http";
  const host = getHeader(request, "x-forwarded-host") || getHeader(request, "host") || "localhost:3000";
  return `${proto}://${host}`;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

function normalizeRedirectEnvValue(raw: string): string | null {
  // Accept common misformats, e.g. `TELEGRAM_OIDC_REDIRECT_URI = http://...`
  // or quoted values from copied snippets.
  const urlMatch = raw.match(/https?:\/\/\S+/i);
  const candidate = (urlMatch ? urlMatch[0] : raw).trim().replace(/^['"]|['"]$/g, "");
  if (!candidate) return null;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol === "http:" && !isLocalHostname(u.hostname)) {
    u.protocol = "https:";
  }
  return u.toString();
}

function getRedirectUri(request: AnyRequest): string {
  const derived = `${getRequestOrigin(request)}${CALLBACK_PATH}`;
  const explicitRaw = process.env.TELEGRAM_OIDC_REDIRECT_URI?.trim();
  if (explicitRaw) {
    const normalized = normalizeRedirectEnvValue(explicitRaw);
    const parsed = normalized ? tryParseClientRedirectUri(normalized) : null;
    if (parsed) {
      if (new URL(parsed).origin === new URL(derived).origin) {
        return parsed;
      }
      appWarn("[auth-telegram-start]", "env_redirect_origin_mismatch_using_request", {
        envOrigin: new URL(parsed).origin,
        requestOrigin: new URL(derived).origin,
      });
    } else {
      appWarn("[auth-telegram-start]", "invalid_env", { key: "TELEGRAM_OIDC_REDIRECT_URI" });
    }
  }
  return derived;
}

const CALLBACK_PATH = "/api/auth/telegram/callback";

/** Absolute callback URL from client (must match authorize + token exchange). */
function tryParseClientRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.pathname !== CALLBACK_PATH) return null;
  return u.href;
}

function assertValidRedirectUri(redirectUri: string): void {
  if (!redirectUri.trim()) {
    throw new Error("redirect_uri_empty");
  }
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    throw new Error("redirect_uri_invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("redirect_uri_not_http");
  }
  if (u.pathname !== CALLBACK_PATH) {
    throw new Error("redirect_uri_wrong_path");
  }
}

function getClientMeta(request: AnyRequest): { ip: string | null; userAgent: string | null } {
  const xff = getHeader(request, "x-forwarded-for");
  const ip = xff ? xff.split(",")[0]?.trim() || null : null;
  const userAgent = getHeader(request, "user-agent");
  return { ip, userAgent };
}

function tryParsePageOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function resolveRedirectUri(request: AnyRequest, bodyRedirectUri: unknown, pageOrigin: unknown): string {
  const fromClient = tryParseClientRedirectUri(bodyRedirectUri);
  if (fromClient) {
    const clientOrigin = new URL(fromClient).origin;
    const serverOrigin = getRequestOrigin(request);
    if (clientOrigin === serverOrigin) {
      return fromClient;
    }
    const page = tryParsePageOrigin(pageOrigin);
    if (page && page === clientOrigin) {
      return fromClient;
    }
  }
  return getRedirectUri(request);
}

function sendJson(body: object, status = 200, request?: AnyRequest): Response {
  const headers = new Headers(JSON_HEADERS);
  if (request) applyAuthApiCors(request, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

function sendJsonViaRes(res: NodeRes, body: object, status = 200, request?: AnyRequest): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  if (request) {
    const headers = new Headers();
    applyAuthApiCors(request, headers);
    headers.forEach((v, k) => res.setHeader(k, v));
  }
  res.end(JSON.stringify(body));
}

async function handler(request: AnyRequest, res?: NodeRes): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) {
    if (res) {
      res.status(preflight.status);
      preflight.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return preflight;
  }

  const method = (request as { method?: string }).method ?? request.method;
  if (method !== "POST") {
    const body = { ok: false, error: "method_not_allowed" };
    if (res) return sendJsonViaRes(res, body, 405, request);
    return sendJson(body, 405, request);
  }

  let bodyJson: { redirect_uri?: unknown; source?: unknown; page_origin?: unknown } = {};
  try {
    bodyJson = await parseRequestJsonBody<{
      redirect_uri?: unknown;
      source?: unknown;
      page_origin?: unknown;
    }>(request);
  } catch {
    bodyJson = {};
  }

  const requestOrigin = getRequestOrigin(request);
  const pageOrigin = tryParsePageOrigin(bodyJson.page_origin);
  const { ip, userAgent } = getClientMeta(request);
  appLogEvent("[auth-telegram-start]", {
      event: "request",
      origin: requestOrigin,
      source: typeof bodyJson.source === "string" ? bodyJson.source : null,
      hasClientRedirectUri: Boolean(tryParseClientRedirectUri(bodyJson.redirect_uri)),
      pageOrigin,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 120) : null,
    });

  const clientId = resolveTelegramBotId();
  if (!clientId || !/^\d+$/.test(clientId)) {
    const body = { ok: false, error: "telegram_client_id_not_configured" };
    if (res) return sendJsonViaRes(res, body, 500, request);
    return sendJson(body, 500, request);
  }

  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  let redirectUri: string;
  try {
    redirectUri = resolveRedirectUri(request, bodyJson.redirect_uri, bodyJson.page_origin);
    assertValidRedirectUri(redirectUri);
  } catch (e) {
    const code = e instanceof Error ? e.message : "redirect_uri_invalid";
    const body = { ok: false, error: code };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }
  const { id, expiresAtIso } = createEphemeralAttempt({
    stateHash: sha256Hex(state),
    nonceHash: sha256Hex(nonce),
    pkceVerifier: codeVerifier,
    redirectUri,
    ttlMs: ATTEMPT_TTL_MS,
  });

  try {
    await createLoginAttempt({
      id,
      provider: "telegram",
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      pkceVerifier: codeVerifier,
      redirectUri,
      expiresAtIso,
      ip,
      userAgent,
    });
  } catch (err) {
    appError("[auth-telegram-start]", "createLoginAttempt_failed", undefined, err);
    const body = { ok: false, error: "login_attempt_persist_failed" };
    if (res) return sendJsonViaRes(res, body, 500, request);
    return sendJson(body, 500, request);
  }

  const authUrl = buildTelegramAuthorizeUrl({
    clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
  });

  const body = { ok: true, authUrl };
  let authUrlHost: string | null = null;
  try {
    authUrlHost = new URL(authUrl).host;
  } catch {
    authUrlHost = null;
  }
  appLogEvent("[auth-telegram-start]", {
      event: "issued",
      attemptId: id,
      redirectUriHost: (() => {
        try {
          return new URL(redirectUri).host;
        } catch {
          return null;
        }
      })(),
      authUrlHost,
      expiresAtIso,
    });
  if (res) return sendJsonViaRes(res, body, 200, request);
  return sendJson(body, 200, request);
}

export default handler;
export const POST = handler;
export const GET = handler;
export const OPTIONS = handler;


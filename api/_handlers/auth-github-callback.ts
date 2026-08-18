import {
  exchangeGithubCodeForTokens,
  fetchGithubUserProfile,
  randomUrlSafe,
  sha256Hex,
} from "../_lib/github-oauth.js";
import { appError, appLogEvent, appWarn } from "../../shared/appLog.js";
import {
  createSession,
  getLoginAttemptByStateHash,
  logLoginEvent,
  markLoginAttemptStatus,
  upsertGithubIdentity,
} from "../../database/telegramAuth.js";
import { normalizeUsername, upsertUserFromTma } from "../../database/users.js";
import { deliverWelcomeFeedIfNeeded } from "../../database/feed.js";
import {
  getEphemeralAttempt,
  setEphemeralAttemptStatus,
} from "../_lib/telegram-attempt-store.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};
type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const SESSION_COOKIE = "hs_auth_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function getRequestUrl(request: AnyRequest): URL {
  const raw = (request as { url?: string }).url ?? "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new URL(raw);
  }
  const proto = getHeader(request, "x-forwarded-proto") || "http";
  const host = getHeader(request, "x-forwarded-host") || getHeader(request, "host") || "localhost:3000";
  const pathname = raw.startsWith("/") ? raw : `/${raw}`;
  return new URL(`${proto}://${host}${pathname}`);
}

function getClientMeta(request: AnyRequest): { ip: string | null; userAgent: string | null } {
  const xff = getHeader(request, "x-forwarded-for");
  const ip = xff ? xff.split(",")[0]?.trim() || null : null;
  const userAgent = getHeader(request, "user-agent");
  return { ip, userAgent };
}

function appendSetCookie(headers: Headers, value: string): void {
  headers.append("Set-Cookie", value);
}

function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function resolvePostAuthRedirect(request: AnyRequest): string {
  const origin = getRequestUrl(request).origin;
  return `${origin}/`;
}

function resolvePostAuthRedirectFromCallback(
  request: AnyRequest,
  callbackRedirectUri: string,
): string {
  try {
    const callbackUrl = new URL(callbackRedirectUri);
    callbackUrl.pathname = "/";
    callbackUrl.search = "";
    callbackUrl.hash = "";
    return callbackUrl.toString();
  } catch {
    return resolvePostAuthRedirect(request);
  }
}

function resolveGithubUsername(profile: { id: number }): string {
  return normalizeUsername(`github_${profile.id}`);
}

function failRedirect(request: AnyRequest, reason: string): Response {
  const url = new URL(resolvePostAuthRedirect(request));
  url.pathname = "/";
  url.searchParams.set("githubAuthError", reason);
  return Response.redirect(url.toString(), 302);
}

function sendRedirect(response: Response, res?: NodeRes): Response | void {
  if (res) {
    res.status(response.status);
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end();
    return;
  }
  return response;
}

type ResolvedAttempt = {
  id: string;
  nonceHash: string;
  pkceVerifier: string;
  redirectUri: string;
  status: "created" | "consumed" | "expired" | "failed";
  expiresAtMs: number;
};

function markAttemptStatus(
  stateHash: string,
  attemptId: string,
  status: "consumed" | "expired" | "failed",
  errorCode?: string | null,
): void {
  setEphemeralAttemptStatus(stateHash, status, errorCode);
  markLoginAttemptStatus({ id: attemptId, status, errorCode }).catch(() => {});
}

async function resolveAttempt(stateHash: string): Promise<ResolvedAttempt | null> {
  const mem = getEphemeralAttempt(stateHash);
  if (mem) {
    return {
      id: mem.id,
      nonceHash: mem.nonceHash,
      pkceVerifier: mem.pkceVerifier,
      redirectUri: mem.redirectUri,
      status: mem.status,
      expiresAtMs: mem.expiresAtMs,
    };
  }
  const row = await getLoginAttemptByStateHash(stateHash);
  if (!row) return null;
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    pkceVerifier: row.pkce_verifier,
    redirectUri: row.redirect_uri,
    status: row.status,
    expiresAtMs: new Date(row.expires_at).getTime(),
  };
}

async function handler(request: AnyRequest, res?: NodeRes): Promise<Response | void> {
  const method = (request as { method?: string }).method ?? request.method;
  if (method !== "GET") {
    const response = new Response("Method Not Allowed", { status: 405 });
    if (res) {
      res.status(405);
      res.end("Method Not Allowed");
      return;
    }
    return response;
  }

  const url = getRequestUrl(request);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const oauthError = url.searchParams.get("error") ?? "";
  const oauthErrorDescription = url.searchParams.get("error_description") ?? "";
  const { ip, userAgent } = getClientMeta(request);

  appLogEvent("[auth-github-callback]", {
      event: "request",
      origin: url.origin,
      hasCode: Boolean(code),
      hasState: Boolean(state),
      oauthError: oauthError || null,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 120) : null,
    });

  if (oauthError) {
    if (!state) {
      return sendRedirect(failRedirect(request, "missing_state"), res);
    }

    const stateHash = sha256Hex(state);
    const deniedAttempt = await resolveAttempt(stateHash);
    if (!deniedAttempt) {
      return sendRedirect(failRedirect(request, "state_not_found"), res);
    }

    const reason = oauthError === "access_denied" ? "access_denied" : oauthError;
    markAttemptStatus(stateHash, deniedAttempt.id, "failed", reason);
    await logLoginEvent({
      attemptId: deniedAttempt.id,
      provider: "github",
      eventType: "failure",
      ip,
      userAgent,
      metaJson: {
        reason,
        error_description: oauthErrorDescription || null,
      },
    }).catch(() => {});

    appLogEvent("[auth-github-callback]", {
        event: "oauth_denied",
        attemptId: deniedAttempt.id,
        reason,
        errorDescription: oauthErrorDescription || null,
      });
    return sendRedirect(failRedirect(request, reason), res);
  }

  if (!code || !state) {
    return sendRedirect(failRedirect(request, "missing_code_or_state"), res);
  }

  const stateHash = sha256Hex(state);
  const attempt = await resolveAttempt(stateHash);
  if (!attempt) {
    return sendRedirect(failRedirect(request, "state_not_found"), res);
  }

  if (attempt.status !== "created") {
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "github",
      eventType: "failure",
      ip,
      userAgent,
      metaJson: { reason: "attempt_not_active", status: attempt.status },
    }).catch(() => {});
    const response = failRedirect(request, "attempt_not_active");
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  }

  if (attempt.expiresAtMs <= Date.now()) {
    markAttemptStatus(stateHash, attempt.id, "expired", "attempt_expired");
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "github",
      eventType: "failure",
      ip,
      userAgent,
      metaJson: { reason: "attempt_expired" },
    }).catch(() => {});
    const response = failRedirect(request, "attempt_expired");
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) {
    markAttemptStatus(stateHash, attempt.id, "failed", "oauth_not_configured");
    const response = failRedirect(request, "oauth_not_configured");
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  }

  if (!attempt.redirectUri.trim()) {
    markAttemptStatus(stateHash, attempt.id, "failed", "redirect_uri_missing");
    const response = failRedirect(request, "redirect_uri_missing");
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  }

  try {
    const tokens = await exchangeGithubCodeForTokens({
      code,
      redirectUri: attempt.redirectUri,
      clientId,
      clientSecret,
      codeVerifier: attempt.pkceVerifier,
    });
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "github",
      eventType: "token_exchanged",
      ip,
      userAgent,
    }).catch(() => {});

    const profile = await fetchGithubUserProfile(tokens.access_token);
    const providerSubject = String(profile.id);
    const telegramUsername = resolveGithubUsername(profile);
    await upsertUserFromTma({
      telegramUsername,
      locale: null,
      email: profile.email,
      displayName: profile.name ?? profile.login,
      pictureUrl: profile.avatar_url,
      authProvider: "github",
      loginSubject: providerSubject,
      providerUsername: profile.login,
      seenVia: "login",
    });
    await deliverWelcomeFeedIfNeeded({ telegramUsername, localePreferred: null }).catch(() => {});
    await upsertGithubIdentity({
      providerSubject,
      telegramUsername,
      login: profile.login,
      email: profile.email,
      displayName: profile.name ?? profile.login,
      pictureUrl: profile.avatar_url,
      claimsVersion: "oauth-v1",
    });

    const sessionToken = randomUrlSafe(32);
    const sessionHash = sha256Hex(sessionToken);
    const expiresAtIso = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await createSession({
      sessionHash,
      telegramUsername,
      expiresAtIso,
      ip,
      userAgent,
    });
    markAttemptStatus(stateHash, attempt.id, "consumed");
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "github",
      eventType: "session_issued",
      telegramUsername,
      providerSubject,
      ip,
      userAgent,
    }).catch(() => {});

    const headers = new Headers({
      Location: resolvePostAuthRedirectFromCallback(request, attempt.redirectUri),
    });
    appendSetCookie(headers, buildSessionCookie(sessionToken, url.protocol === "https:"));
    appLogEvent("[auth-github-callback]", {
        event: "success",
        attemptId: attempt.id,
        telegramUsername,
        redirectTo: headers.get("Location"),
      });
    const response = new Response(null, { status: 302, headers });
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "callback_failed";
    appLogEvent("[auth-github-callback]", {
        event: "failure",
        attemptId: attempt.id,
        reason,
      });
    markAttemptStatus(stateHash, attempt.id, "failed", reason);
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "github",
      eventType: "failure",
      ip,
      userAgent,
      metaJson: { reason },
    }).catch(() => {});
    const response = failRedirect(request, reason);
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return response;
  }
}

export default handler;
export const GET = handler;

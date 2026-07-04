import { deliverWelcomeFeedIfNeeded } from "../../database/feed.js";
import {
  getLoginAttemptById,
  logLoginEvent,
  markLoginAttemptStatus,
  upsertEmailIdentity,
} from "../../database/telegramAuth.js";
import { normalizeUsername, upsertUserFromTma } from "../../database/users.js";
import { appError, appLogEvent } from "../../shared/appLog.js";
import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import {
  emailDisplayNameFromAddress,
  normalizeEmail,
  resolveEmailUsername,
  verifyEmailOtpHash,
} from "../_lib/email-auth.js";
import { issueAuthSession } from "../_lib/auth-session-issue.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};
type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

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

function getClientMeta(request: AnyRequest): { ip: string | null; userAgent: string | null } {
  const xff = getHeader(request, "x-forwarded-for");
  const ip = xff ? xff.split(",")[0]?.trim() || null : null;
  const userAgent = getHeader(request, "user-agent");
  return { ip, userAgent };
}

function isSecureRequest(request: AnyRequest): boolean {
  const xfProto = getHeader(request, "x-forwarded-proto");
  if (xfProto) return xfProto.split(",")[0]?.trim() === "https";
  const rawUrl = (request as { url?: string }).url ?? "";
  return rawUrl.startsWith("https://");
}

function sendJson(
  body: object,
  status = 200,
  request?: AnyRequest,
  extraHeaders?: Headers,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    extraHeaders.forEach((v, k) => headers.append(k, v));
  }
  if (request) applyAuthApiCors(request, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

function sendJsonViaRes(
  res: NodeRes,
  body: object,
  status = 200,
  request?: AnyRequest,
  extraHeaders?: Headers,
): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  if (extraHeaders) {
    extraHeaders.forEach((v, k) => res.setHeader(k, v));
  }
  if (request) {
    const headers = new Headers();
    applyAuthApiCors(request, headers);
    headers.forEach((v, k) => {
      if (k.toLowerCase() !== "set-cookie") res.setHeader(k, v);
    });
  }
  res.end(JSON.stringify(body));
}

function normalizeOtpCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  return code;
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

  const bodyJson = await parseRequestJsonBody<{ attemptId?: unknown; code?: unknown }>(request);
  const attemptId = typeof bodyJson.attemptId === "string" ? bodyJson.attemptId.trim() : "";
  const code = normalizeOtpCode(bodyJson.code);
  const { ip, userAgent } = getClientMeta(request);

  appLogEvent("[auth-email-verify]", {
    event: "request",
    hasAttemptId: Boolean(attemptId),
    hasCode: Boolean(code),
    ip,
    userAgent: userAgent ? userAgent.slice(0, 120) : null,
  });

  if (!attemptId || !code) {
    const body = { ok: false, error: "invalid_request" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  const attempt = await getLoginAttemptById(attemptId).catch((err) => {
    appError("[auth-email-verify]", "getLoginAttemptById_failed", { attemptId }, err);
    return null;
  });

  if (!attempt) {
    const body = { ok: false, error: "invalid_code" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  const email = normalizeEmail(attempt.pkce_verifier);
  if (!email) {
    await markLoginAttemptStatus({ id: attempt.id, status: "failed", errorCode: "email_missing" }).catch(
      () => {},
    );
    const body = { ok: false, error: "invalid_code" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  if (attempt.status !== "created") {
    const body = { ok: false, error: "attempt_not_active" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  if (new Date(attempt.expires_at).getTime() <= Date.now()) {
    await markLoginAttemptStatus({ id: attempt.id, status: "expired", errorCode: "attempt_expired" }).catch(
      () => {},
    );
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "email",
      eventType: "failure",
      providerSubject: email,
      ip,
      userAgent,
      metaJson: { reason: "attempt_expired" },
    }).catch(() => {});
    const body = { ok: false, error: "code_expired" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  if (!verifyEmailOtpHash(attempt.nonce_hash, code)) {
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "email",
      eventType: "verify_failed",
      providerSubject: email,
      ip,
      userAgent,
    }).catch(() => {});
    const body = { ok: false, error: "invalid_code" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  const telegramUsername = resolveEmailUsername(email);
  const providerSubject = email;

  try {
    await upsertUserFromTma({
      telegramUsername,
      locale: null,
    });
    await deliverWelcomeFeedIfNeeded({ telegramUsername, localePreferred: null }).catch(() => {});
    await upsertEmailIdentity({
      providerSubject,
      telegramUsername,
      email,
      displayName: emailDisplayNameFromAddress(email),
      claimsVersion: "otp-v1",
    });
    await markLoginAttemptStatus({ id: attempt.id, status: "consumed" });
    const { setCookie } = await issueAuthSession({
      telegramUsername: normalizeUsername(telegramUsername),
      secure: isSecureRequest(request),
      ip,
      userAgent,
    });
    await logLoginEvent({
      attemptId: attempt.id,
      provider: "email",
      eventType: "session_issued",
      telegramUsername,
      providerSubject,
      ip,
      userAgent,
    }).catch(() => {});

    const headers = new Headers();
    headers.append("Set-Cookie", setCookie);
    const body = { ok: true, authenticated: true };
    appLogEvent("[auth-email-verify]", {
      event: "success",
      attemptId: attempt.id,
      telegramUsername,
    });
    if (res) return sendJsonViaRes(res, body, 200, request, headers);
    return sendJson(body, 200, request, headers);
  } catch (err) {
    appError("[auth-email-verify]", "session_issue_failed", { attemptId }, err);
    await markLoginAttemptStatus({ id: attempt.id, status: "failed", errorCode: "session_issue_failed" }).catch(
      () => {},
    );
    const body = { ok: false, error: "session_issue_failed" };
    if (res) return sendJsonViaRes(res, body, 500, request);
    return sendJson(body, 500, request);
  }
}

export default handler;
export const POST = handler;
export const GET = handler;
export const OPTIONS = handler;

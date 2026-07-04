import { appError, appLogEvent } from "../../shared/appLog.js";
import {
  countRecentEmailLoginStarts,
  createLoginAttempt,
  logLoginEvent,
} from "../../database/telegramAuth.js";
import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import {
  createEmailAttemptId,
  EMAIL_OTP_REDIRECT_URI,
  EMAIL_OTP_TTL_MS,
  generateEmailOtp,
  hashEmailOtp,
  normalizeEmail,
  sendEmailOtp,
} from "../_lib/email-auth.js";
import { sha256Hex } from "../_lib/telegram-oidc.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};
type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const JSON_HEADERS = { "Content-Type": "application/json" };
const RATE_LIMIT_WINDOW_MINUTES = 60;
const RATE_LIMIT_MAX_STARTS = 8;

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

  const bodyJson = await parseRequestJsonBody<{ email?: unknown; source?: unknown }>(request);
  const email = normalizeEmail(bodyJson.email);
  const { ip, userAgent } = getClientMeta(request);

  appLogEvent("[auth-email-start]", {
    event: "request",
    source: typeof bodyJson.source === "string" ? bodyJson.source : null,
    hasEmail: Boolean(email),
    ip,
    userAgent: userAgent ? userAgent.slice(0, 120) : null,
  });

  if (!email) {
    const body = { ok: false, error: "invalid_email" };
    if (res) return sendJsonViaRes(res, body, 400, request);
    return sendJson(body, 400, request);
  }

  try {
    const recentStarts = await countRecentEmailLoginStarts({
      ip,
      email,
      windowMinutes: RATE_LIMIT_WINDOW_MINUTES,
    });
    if (recentStarts >= RATE_LIMIT_MAX_STARTS) {
      const body = { ok: false, error: "rate_limited" };
      if (res) return sendJsonViaRes(res, body, 429, request);
      return sendJson(body, 429, request);
    }
  } catch (err) {
    appError("[auth-email-start]", "rate_limit_check_failed", undefined, err);
    const body = { ok: false, error: "login_attempt_persist_failed" };
    if (res) return sendJsonViaRes(res, body, 500, request);
    return sendJson(body, 500, request);
  }

  const attemptId = createEmailAttemptId();
  const otp = generateEmailOtp();
  const expiresAtIso = new Date(Date.now() + EMAIL_OTP_TTL_MS).toISOString();

  try {
    await createLoginAttempt({
      id: attemptId,
      provider: "email",
      stateHash: sha256Hex(attemptId),
      nonceHash: hashEmailOtp(otp),
      pkceVerifier: email,
      redirectUri: EMAIL_OTP_REDIRECT_URI,
      expiresAtIso,
      ip,
      userAgent,
    });
  } catch (err) {
    appError("[auth-email-start]", "createLoginAttempt_failed", undefined, err);
    const body = { ok: false, error: "login_attempt_persist_failed" };
    if (res) return sendJsonViaRes(res, body, 500, request);
    return sendJson(body, 500, request);
  }

  try {
    const delivery = await sendEmailOtp({
      to: email,
      code: otp,
      expiresMinutes: Math.round(EMAIL_OTP_TTL_MS / 60_000),
    });
    await logLoginEvent({
      attemptId,
      provider: "email",
      eventType: delivery.delivered ? "otp_sent" : "otp_dev_logged",
      providerSubject: email,
      ip,
      userAgent,
      metaJson: { devLogged: delivery.devLogged === true },
    }).catch(() => {});
  } catch (err) {
    await logLoginEvent({
      attemptId,
      provider: "email",
      eventType: "otp_send_failed",
      providerSubject: email,
      ip,
      userAgent,
      metaJson: { message: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    appError("[auth-email-start]", "sendEmailOtp_failed", { attemptId }, err);
    const body = { ok: false, error: "email_delivery_failed" };
    if (res) return sendJsonViaRes(res, body, 502, request);
    return sendJson(body, 502, request);
  }

  const body = {
    ok: true,
    attemptId,
    expiresAtIso,
    message: "If this address can sign in, a code was sent.",
  };
  appLogEvent("[auth-email-start]", {
    event: "issued",
    attemptId,
    emailDomain: email.split("@")[1] ?? null,
    expiresAtIso,
  });
  if (res) return sendJsonViaRes(res, body, 200, request);
  return sendJson(body, 200, request);
}

export default handler;
export const POST = handler;
export const GET = handler;
export const OPTIONS = handler;

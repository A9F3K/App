import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";
import { telegramUsernameFromSessionCookie } from "../_lib/session-auth.js";
import {
  gatewayConnectCode,
  gatewayConnectPassword,
  gatewayConnectPhone,
  gatewayConnectResendCode,
  gatewayConnectStart,
  gatewayConnectStatus,
  gatewayHealthCheckDetailed,
  gatewayNotConfiguredResponse,
} from "../_lib/tdlib-gateway-client.js";
import {
  gatewayEnvDiagnostics,
  logTdlibGatewayApi,
} from "../_lib/tdlib-gateway-debug.js";
import { getTelegramApiCredentials } from "../../telegram/tdlib/env.js";
import { isTelegramMessagesLinkRevoked } from "../../database/telegramMessages.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

function requestMethod(request: AnyRequest): string {
  return ((request as { method?: string }).method ?? (request as Request).method ?? "GET").toUpperCase();
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

function finishPreflight(request: AnyRequest, res: NodeRes | undefined, preflight: Response): Response | void {
  if (res) {
    res.status(preflight.status);
    preflight.headers.forEach((v, k) => res.setHeader(k, v));
    res.end();
    return;
  }
  return preflight;
}

async function parseRequestBody<T extends Record<string, unknown> = Record<string, unknown>>(
  request: AnyRequest,
): Promise<T> {
  const raw = request as { body?: unknown; json?: () => Promise<unknown>; text?: () => Promise<string> };
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body === "object" && !Buffer.isBuffer(raw.body)) {
      return raw.body as T;
    }
    if (typeof raw.body === "string" && raw.body.trim()) {
      try {
        return JSON.parse(raw.body) as T;
      } catch {
        return {} as T;
      }
    }
  }
  const webReq = request as Request;
  if (typeof raw.json === "function") {
    try {
      const parsed = await raw.json();
      return (parsed && typeof parsed === "object" ? parsed : {}) as T;
    } catch {
      /* fall through */
    }
  }
  if (typeof webReq.text === "function") {
    try {
      const text = await webReq.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

function finishJson(
  request: AnyRequest,
  res: NodeRes | undefined,
  body: object,
  status = 200,
): Response | void {
  if (res) {
    sendJsonViaRes(res, body, status, request);
    return;
  }
  return sendJson(body, status, request);
}

async function requireUser(request: AnyRequest): Promise<string | Response> {
  const username = await telegramUsernameFromSessionCookie(request);
  if (!username) {
    return sendJson({ ok: false, error: "unauthorized" }, 401, request);
  }
  return username;
}

async function ensureGatewayAvailable(): Promise<{
  error: string | null;
  debug: Record<string, unknown>;
}> {
  const envDiag = gatewayEnvDiagnostics();
  logTdlibGatewayApi("ensure_gateway_env", envDiag);

  if (!getTelegramApiCredentials()) {
    logTdlibGatewayApi("ensure_gateway_fail", {
      reason: "telegram_api_credentials_missing",
      env: envDiag,
    });
    return { error: "telegram_api_credentials_missing", debug: { env: envDiag } };
  }

  const health = await gatewayHealthCheckDetailed();
  logTdlibGatewayApi("ensure_gateway_health", {
    ok: health.ok,
    healthUrlHost: health.healthUrlHost,
    httpStatus: health.httpStatus,
    elapsedMs: health.elapsedMs,
    fetchError: health.fetchError,
    responseBodyPreview: health.responseBodyPreview,
    env: envDiag,
  });

  if (!health.ok) {
    const urlMissingOnVercel =
      envDiag.vercel === true && envDiag.gatewayUrlConfigured === false;
    return {
      error: urlMissingOnVercel ? "tdlib_gateway_url_missing" : "tdlib_gateway_unreachable",
      debug: {
        env: envDiag,
        health: {
          healthUrlHost: health.healthUrlHost,
          httpStatus: health.httpStatus,
          elapsedMs: health.elapsedMs,
          fetchError: health.fetchError,
          responseBodyPreview: health.responseBodyPreview,
        },
      },
    };
  }

  return { error: null, debug: { env: envDiag, health: { ok: true, healthUrlHost: health.healthUrlHost } } };
}

export async function telegramMtprotoConnectStartHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const gatewayError = await ensureGatewayAvailable();
  if (gatewayError.error) {
    logTdlibGatewayApi("connect_start_rejected", {
      error: gatewayError.error,
      telegramUsername: userOrRes,
      debug: gatewayError.debug,
    });
    const body = {
      ok: false,
      ...gatewayNotConfiguredResponse(),
      error: gatewayError.error,
      debug: gatewayError.debug,
    };
    return finishJson(request, res, body, 503);
  }

  logTdlibGatewayApi("connect_start_proceed", { telegramUsername: userOrRes });

  const startBody = await parseRequestBody<{
    resume?: boolean;
    fresh?: boolean;
    authMethod?: "qr" | "phone";
  }>(request);
  let resume = Boolean(startBody.resume);
  let fresh = Boolean(startBody.fresh);
  const authMethod = startBody.authMethod === "phone" ? "phone" : "qr";

  // After explicit logout, never silently resume from on-disk TDLib — start fresh.
  if (resume && !fresh && (await isTelegramMessagesLinkRevoked(userOrRes))) {
    logTdlibGatewayApi("connect_start_revoked_force_fresh", { telegramUsername: userOrRes });
    resume = false;
    fresh = true;
  }

  try {
    const snap = await gatewayConnectStart(userOrRes, { resume, fresh, authMethod });
    const ok = snap.authState !== "failed" || Boolean(snap.attemptId);
    logTdlibGatewayApi("connect_start_gateway_result", {
      telegramUsername: userOrRes,
      ok,
      httpStatus: snap.httpStatus,
      authState: snap.authState ?? null,
      error: snap.error ?? null,
      hasAttemptId: Boolean(snap.attemptId),
      hasQrLink: Boolean(snap.qrLink),
    });
    return finishJson(
      request,
      res,
      {
        ok,
        attemptId: snap.attemptId ?? null,
        authState: snap.authState ?? "failed",
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus >= 400 ? snap.httpStatus : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    logTdlibGatewayApi("connect_start_exception", {
      telegramUsername: userOrRes,
      message,
      stack: err instanceof Error ? err.stack?.slice(0, 500) : null,
    });
    return finishJson(request, res, { ok: false, error: message, authState: "failed" }, 503);
  }
}

export async function telegramMtprotoConnectStatusHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  let attemptId = "";
  try {
    const rawUrl = (request as { url?: string }).url ?? "";
    attemptId = new URL(rawUrl, "http://localhost").searchParams.get("attemptId")?.trim() ?? "";
  } catch {
    attemptId = "";
  }
  if (!attemptId) {
    return finishJson(request, res, { ok: false, error: "attempt_id_required" }, 400);
  }

  try {
    const snap = await gatewayConnectStatus(attemptId);
    return finishJson(
      request,
      res,
      {
        ok: snap.httpStatus < 400,
        attemptId,
        authState: snap.authState ?? "failed",
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    return finishJson(request, res, { ok: false, error: message, authState: "failed" }, 503);
  }
}

export async function telegramMtprotoConnectPasswordHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const body = await parseRequestBody<{ attemptId?: string; password?: string }>(request);
  const attemptId = (body.attemptId || "").trim();
  const password = body.password || "";
  logTdlibGatewayApi("connect_password_request", {
    hasAttemptId: Boolean(attemptId),
    passwordLength: password.length,
  });
  if (!attemptId || !password) {
    return finishJson(
      request,
      res,
      { ok: false, error: "attempt_id_and_password_required", authState: "wait_password" },
      400,
    );
  }

  try {
    const snap = await gatewayConnectPassword(attemptId, password);
    const authState = snap.authState ?? "wait_password";
    logTdlibGatewayApi("connect_password_gateway_result", {
      attemptId,
      httpStatus: snap.httpStatus,
      authState,
      error: snap.error ?? null,
    });
    return finishJson(
      request,
      res,
      {
        ok: authState === "ready" || authState === "wait_password",
        attemptId,
        authState,
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus >= 400 ? snap.httpStatus : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    logTdlibGatewayApi("connect_password_exception", { attemptId, message });
    return finishJson(
      request,
      res,
      { ok: false, error: message, authState: "wait_password" },
      503,
    );
  }
}

export async function telegramMtprotoConnectPhoneHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const body = await parseRequestBody<{
    attemptId?: string;
    phoneNumber?: string;
    isCurrentPhoneNumber?: boolean;
  }>(request);
  const attemptId = (body.attemptId || "").trim();
  const phoneNumber = body.phoneNumber || "";
  if (!attemptId || !phoneNumber.trim()) {
    return finishJson(
      request,
      res,
      { ok: false, error: "attempt_id_and_phone_required", authState: "wait_phone" },
      400,
    );
  }

  try {
    const snap = await gatewayConnectPhone(attemptId, phoneNumber, {
      isCurrentPhoneNumber: Boolean(body.isCurrentPhoneNumber),
    });
    const authState = snap.authState ?? "wait_phone";
    const gatewayFailed = snap.httpStatus >= 400 || snap.error === "not_found" || snap.error === "attempt_not_found";
    return finishJson(
      request,
      res,
      {
        ok:
          !gatewayFailed &&
          (authState === "wait_code" ||
            authState === "wait_password" ||
            authState === "ready" ||
            authState === "wait_phone"),
        attemptId,
        authState,
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus >= 400 ? snap.httpStatus : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    return finishJson(request, res, { ok: false, error: message, authState: "wait_phone" }, 503);
  }
}

export async function telegramMtprotoConnectCodeHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const body = await parseRequestBody<{ attemptId?: string; code?: string }>(request);
  const attemptId = (body.attemptId || "").trim();
  const code = body.code || "";
  if (!attemptId || !code.trim()) {
    return finishJson(
      request,
      res,
      { ok: false, error: "attempt_id_and_code_required", authState: "wait_code" },
      400,
    );
  }

  try {
    const snap = await gatewayConnectCode(attemptId, code);
    const authState = snap.authState ?? "wait_code";
    return finishJson(
      request,
      res,
      {
        ok: authState === "wait_password" || authState === "ready" || authState === "wait_code",
        attemptId,
        authState,
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus >= 400 ? snap.httpStatus : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    return finishJson(request, res, { ok: false, error: message, authState: "wait_code" }, 503);
  }
}

export async function telegramMtprotoConnectResendCodeHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const body = await parseRequestBody<{ attemptId?: string }>(request);
  const attemptId = (body.attemptId || "").trim();
  if (!attemptId) {
    return finishJson(
      request,
      res,
      { ok: false, error: "attempt_id_required", authState: "wait_code" },
      400,
    );
  }

  try {
    const snap = await gatewayConnectResendCode(attemptId);
    const authState = snap.authState ?? "wait_code";
    return finishJson(
      request,
      res,
      {
        ok: authState === "wait_code",
        attemptId,
        authState,
        qrLink: snap.qrLink ?? null,
        error: snap.error ?? null,
        chatCount: snap.chatCount ?? null,
        codeDelivery: snap.codeDelivery ?? null,
      },
      snap.httpStatus >= 400 ? snap.httpStatus : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gateway_error";
    return finishJson(request, res, { ok: false, error: message, authState: "wait_code" }, 503);
  }
}

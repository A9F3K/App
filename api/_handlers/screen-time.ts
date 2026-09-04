/**
 * Per-user screen-time telemetry.
 * POST /api/screen-time  — heartbeat | end (auth session required)
 * GET  /api/screen-time  — totals + recent sessions
 */

import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import { telegramUsernameFromSessionCookie } from "../_lib/session-auth.js";
import {
  applyScreenTimeHeartbeat,
  getScreenTimeTotals,
  listRecentScreenSessions,
} from "../../database/userScreenTime.js";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function respond(
  res: NodeRes | undefined,
  body: object,
  status: number,
): Promise<Response | void> {
  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(JSON.stringify(body));
    return;
  }
  return jsonResponse(body, status);
}

function asClientSessionId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 80);
}

function asDeltaMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asPlatform(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase().slice(0, 32);
  return t || null;
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    return respond(res, { ok: true }, 204);
  }

  const username = await telegramUsernameFromSessionCookie(request);
  if (!username) {
    return respond(res, { ok: false, error: "unauthorized" }, 401);
  }

  if (method === "GET") {
    const [totals, sessions] = await Promise.all([
      getScreenTimeTotals(username),
      listRecentScreenSessions(username, 25),
    ]);
    return respond(
      res,
      {
        ok: true,
        totals: totals ?? {
          total_active_ms: 0,
          session_count: 0,
          last_active_at: null,
        },
        sessions,
      },
      200,
    );
  }

  if (method !== "POST") {
    return respond(res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const body = await parseRequestJsonBody<{
    action?: unknown;
    client_session_id?: unknown;
    delta_ms?: unknown;
    platform?: unknown;
  }>(request);

  const actionRaw = typeof body.action === "string" ? body.action.trim().toLowerCase() : "heartbeat";
  const end = actionRaw === "end";
  if (actionRaw !== "heartbeat" && actionRaw !== "end") {
    return respond(res, { ok: false, error: "invalid_action" }, 400);
  }

  const clientSessionId = asClientSessionId(body.client_session_id);
  if (!clientSessionId) {
    return respond(res, { ok: false, error: "missing_client_session_id" }, 400);
  }

  const userAgent =
    typeof (request as Request).headers?.get === "function"
      ? (request as Request).headers.get("user-agent")
      : null;

  try {
    const result = await applyScreenTimeHeartbeat({
      telegramUsername: username,
      clientSessionId,
      deltaMs: asDeltaMs(body.delta_ms),
      end,
      platform: asPlatform(body.platform),
      userAgent,
    });
    return respond(
      res,
      {
        ok: true,
        ...result,
      },
      200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "screen_time_failed";
    return respond(res, { ok: false, error: message }, 500);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;

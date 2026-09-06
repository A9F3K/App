/**
 * Support chat API (user ↔ staff; not AI).
 * GET/POST /api/support
 */
import { telegramUsernameFromSessionCookie } from "../_lib/session-auth.js";
import { isFounderAuthorized } from "../_lib/founder-auth.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import {
  ensureSupportTables,
  ensureSupportThreadForUser,
  getSupportThreadById,
  insertSupportMessage,
  listSupportMessages,
  listSupportThreadsForStaff,
  markSupportThreadReadByStaff,
} from "../../database/supportChats.js";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(res: NodeRes | undefined, body: object, status: number): Response | void {
  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(JSON.stringify(body));
    return;
  }
  return json(body, status);
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  try {
    try {
      await ensureSupportTables();
    } catch {
      /* migrate may already have created tables */
    }

    const method = (request as { method?: string }).method ?? "GET";
    const rawUrl = (request as { url?: string }).url ?? "";
    const url = new URL(rawUrl, "http://localhost");
    const staff = url.searchParams.get("staff") === "1";

    if (method === "GET") {
      if (staff) {
        if (!isFounderAuthorized(request)) {
          return respond(res, { ok: false, error: "unauthorized" }, 401);
        }
        const threadId = url.searchParams.get("threadId");
        if (threadId) {
          const thread = await getSupportThreadById(threadId);
          if (!thread) return respond(res, { ok: false, error: "not_found" }, 404);
          await markSupportThreadReadByStaff(threadId);
          const messages = await listSupportMessages(threadId);
          return respond(res, { ok: true, thread, messages }, 200);
        }
        const threads = await listSupportThreadsForStaff();
        return respond(res, { ok: true, threads }, 200);
      }

      const username = await telegramUsernameFromSessionCookie(request);
      if (!username) return respond(res, { ok: false, error: "unauthorized" }, 401);
      const thread = await ensureSupportThreadForUser(username);
      const messages = await listSupportMessages(thread.id);
      return respond(res, { ok: true, thread, messages }, 200);
    }

    if (method !== "POST") {
      return respond(res, { ok: false, error: "method_not_allowed" }, 405);
    }

    const payload = await parseRequestJsonBody(request);
    const action = String(payload.action ?? "send");
    const content = String(payload.content ?? "").trim();
    if (!content || content.length > 4000) {
      return respond(res, { ok: false, error: "content_required" }, 400);
    }

    if (action === "staff_reply") {
      if (!isFounderAuthorized(request)) {
        return respond(res, { ok: false, error: "unauthorized" }, 401);
      }
      const threadId = String(payload.threadId ?? "");
      const thread = await getSupportThreadById(threadId);
      if (!thread) return respond(res, { ok: false, error: "not_found" }, 404);
      const message = await insertSupportMessage({
        threadId,
        role: "staff",
        content,
      });
      return respond(res, { ok: true, message }, 200);
    }

    const username = await telegramUsernameFromSessionCookie(request);
    if (!username) return respond(res, { ok: false, error: "unauthorized" }, 401);
    const thread = await ensureSupportThreadForUser(username);
    const message = await insertSupportMessage({
      threadId: thread.id,
      role: "user",
      content,
    });
    return respond(res, { ok: true, thread, message }, 200);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "internal_error";
    return respond(res, { ok: false, error: message }, 500);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;

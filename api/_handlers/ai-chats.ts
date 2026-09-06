/**
 * AI agent column chats API.
 * POST /api/ai-chats { action, ... }
 */
import { telegramUsernameFromSessionCookie } from "../_lib/session-auth.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import {
  claimSharedAiAgentChat,
  createAiAgentChat,
  ensureAiAgentChatTables,
  ensureShareToken,
  getAiAgentChatById,
  getAiAgentChatByShareToken,
  insertAiAgentMessage,
  listAiAgentChatsForUser,
  listAiAgentMessages,
  renameAiAgentChat,
  softDeleteAiAgentChat,
  toggleAiAgentMessageLike,
} from "../../database/aiAgentChats.js";

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

async function suggestTitle(userText: string, priorTitle: string): Promise<string> {
  const { callOpenAiChat } = await import("../../ai/openai.js");
  const model = "gpt-4.1-mini";
  const result = await callOpenAiChat("chat", {
    input: userText,
    model,
    instructions:
      "Return ONLY a short chat tab title (2–6 words, no quotes, no punctuation at end). " +
      `Current title: "${priorTitle}". Improve it based on the latest user message if useful; otherwise keep a close variant.`,
  });
  const raw = (result.output_text ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw || raw.length > 80) {
    const fallback = userText.trim().slice(0, 48);
    return fallback || priorTitle || "New Agent";
  }
  return raw.slice(0, 80);
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  try {
    try {
      await ensureAiAgentChatTables();
    } catch {
      /* tables may already exist from migrate */
    }

    const method = (request as { method?: string }).method ?? "GET";

    if (method === "GET") {
      const rawUrl = (request as { url?: string }).url ?? "";
      const url = new URL(rawUrl, "http://localhost");
      const shareToken = url.searchParams.get("share");
      if (shareToken) {
        const chat = await getAiAgentChatByShareToken(shareToken);
        if (!chat || chat.deleted_at) {
          return respond(res, { ok: false, error: "not_found" }, 404);
        }
        const messages = await listAiAgentMessages({ chatId: chat.id });
        return respond(
          res,
          {
            ok: true,
            chat: {
              id: chat.id,
              title: chat.title,
              shareToken: chat.share_token,
              ownerUsername: chat.owner_username,
            },
            messages: messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              model: m.model,
              createdAt: m.created_at,
              likeCount: m.like_count,
            })),
          },
          200,
        );
      }

      const username = await telegramUsernameFromSessionCookie(request);
      if (!username) return respond(res, { ok: false, error: "unauthorized" }, 401);
      const chats = await listAiAgentChatsForUser(username);
      return respond(res, { ok: true, chats }, 200);
    }

    if (method !== "POST") {
      return respond(res, { ok: false, error: "method_not_allowed" }, 405);
    }

    const payload = await parseRequestJsonBody(request);
    if (!payload || typeof payload !== "object") {
      return respond(res, { ok: false, error: "invalid_json" }, 400);
    }

    const action = String(payload.action ?? "");

    // Public claim after sign-in.
    if (action === "claim_share") {
      const username = await telegramUsernameFromSessionCookie(request);
      if (!username) return respond(res, { ok: false, error: "unauthorized" }, 401);
      const token = String(payload.shareToken ?? "").trim();
      if (!token) return respond(res, { ok: false, error: "share_token_required" }, 400);
      const chat = await claimSharedAiAgentChat({
        shareToken: token,
        claimantUsername: username,
      });
      if (!chat) return respond(res, { ok: false, error: "not_found" }, 404);
      const messages = await listAiAgentMessages({
        chatId: chat.id,
        viewerUsername: username,
      });
      return respond(res, { ok: true, chat, messages }, 200);
    }

    const username = await telegramUsernameFromSessionCookie(request);
    if (!username) return respond(res, { ok: false, error: "unauthorized" }, 401);

    if (action === "create") {
      const clientId = typeof payload.clientId === "string" ? payload.clientId : undefined;
      const title = typeof payload.title === "string" ? payload.title : undefined;
      const chat = await createAiAgentChat({
        ownerUsername: username,
        title,
        id: clientId,
      });
      return respond(res, { ok: true, chat }, 200);
    }

    if (action === "list_messages") {
      const chatId = String(payload.chatId ?? "");
      const chat = await getAiAgentChatById(chatId);
      if (!chat || chat.owner_username !== username || chat.deleted_at) {
        return respond(res, { ok: false, error: "not_found" }, 404);
      }
      const messages = await listAiAgentMessages({
        chatId,
        viewerUsername: username,
      });
      return respond(res, { ok: true, chat, messages }, 200);
    }

    if (action === "rename") {
      const chatId = String(payload.chatId ?? "");
      const title = String(payload.title ?? "");
      const chat = await renameAiAgentChat({
        chatId,
        ownerUsername: username,
        title,
      });
      if (!chat) return respond(res, { ok: false, error: "not_found" }, 404);
      return respond(res, { ok: true, chat }, 200);
    }

    if (action === "delete") {
      const chatId = String(payload.chatId ?? "");
      const ok = await softDeleteAiAgentChat({
        chatId,
        ownerUsername: username,
      });
      return respond(res, { ok }, ok ? 200 : 404);
    }

    if (action === "share") {
      const chatId = String(payload.chatId ?? "");
      const token = await ensureShareToken({ chatId, ownerUsername: username });
      if (!token) return respond(res, { ok: false, error: "not_found" }, 404);
      return respond(res, { ok: true, shareToken: token }, 200);
    }

    if (action === "like") {
      const messageId = String(payload.messageId ?? "");
      if (!messageId) return respond(res, { ok: false, error: "message_id_required" }, 400);
      const result = await toggleAiAgentMessageLike({
        messageId,
        username,
      });
      return respond(res, { ok: true, ...result }, 200);
    }

    if (action === "send") {
      const { callOpenAiChat, selectSmartChatModel } = await import("../../ai/openai.js");
      const chatId = String(payload.chatId ?? "");
      const input = String(payload.input ?? "").trim();
      if (!input) return respond(res, { ok: false, error: "input_required" }, 400);

      let chat = chatId ? await getAiAgentChatById(chatId) : null;
      if (chat && (chat.owner_username !== username || chat.deleted_at)) {
        return respond(res, { ok: false, error: "not_found" }, 404);
      }
      if (!chat) {
        try {
          chat = await createAiAgentChat({
            ownerUsername: username,
            id: typeof payload.clientId === "string" ? payload.clientId : undefined,
          });
        } catch {
          const fallbackId =
            typeof payload.clientId === "string" ? payload.clientId : chatId;
          chat = fallbackId ? await getAiAgentChatById(fallbackId) : null;
          if (!chat || chat.owner_username !== username || chat.deleted_at) {
            return respond(res, { ok: false, error: "create_failed" }, 500);
          }
        }
      }

      const userMessage = await insertAiAgentMessage({
        chatId: chat.id,
        role: "user",
        content: input,
      });

      const history = await listAiAgentMessages({ chatId: chat.id });
      const historyBlock = history
        .slice(0, -1)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      const model = selectSmartChatModel(input);
      const ai = await callOpenAiChat("chat", {
        input: historyBlock
          ? `Previous conversation:\n${historyBlock}\n\nuser: ${input}`
          : input,
        model,
        instructions:
          "You are the Hyperlinks Space Program AI assistant in the AI & Search column. " +
          "Answer clearly and helpfully. Prefer concise Markdown-friendly prose.",
      });

      if (!ai.ok || !ai.output_text?.trim()) {
        return respond(
          res,
          { ok: false, error: ai.error ?? "ai_failed", chatId: chat.id },
          500,
        );
      }

      const assistant = await insertAiAgentMessage({
        chatId: chat.id,
        role: "assistant",
        content: ai.output_text.trim(),
        model: String(ai.meta?.model ?? model),
      });

      const nextTitle = await suggestTitle(input, chat.title);
      const renamed =
        (await renameAiAgentChat({
          chatId: chat.id,
          ownerUsername: username,
          title: nextTitle,
        })) ?? chat;

      return respond(
        res,
        {
          ok: true,
          chat: renamed,
          userMessage,
          assistantMessage: assistant,
          model: String(ai.meta?.model ?? model),
        },
        200,
      );
    }

    return respond(res, { ok: false, error: "unknown_action" }, 400);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "internal_error";
    return respond(res, { ok: false, error: message }, 500);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;

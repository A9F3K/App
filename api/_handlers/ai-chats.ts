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
import {
  canStartAiFreeTurn,
  consumeAiFreeTokens,
  ensureAiFreeQuotaTable,
  estimateTextTokens,
  getAiFreeQuota,
  syncAiFreeQuotaPro,
  updateAiUserPrefs,
  type AiModelMode,
} from "../../database/aiFreeQuota.js";
import { AI_TOOLS_MODEL_OPTIONS } from "../../ai/llmRouter.js";
import { toPublicAiErrorCode } from "../../ai/publicAiErrors.js";

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
  const { isOpenAiConfigured, isVercelGatewayConfigured } = await import(
    "../../ai/llmRouter.js"
  );
  if (!isOpenAiConfigured() && !isVercelGatewayConfigured()) {
    const fallback = userText.trim().slice(0, 48);
    return fallback || priorTitle || "New Agent";
  }
  const result = await callOpenAiChat("chat", {
    input: userText,
    model: "gpt-4.1-mini",
    preferFrontier: false,
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
      await ensureAiFreeQuotaTable();
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

    if (action === "quota") {
      const quota = await getAiFreeQuota(username);
      return respond(res, { ok: true, quota, models: AI_TOOLS_MODEL_OPTIONS }, 200);
    }

    if (action === "sync_pro") {
      const expiresAt =
        typeof payload.expiresAt === "string" && payload.expiresAt.trim()
          ? payload.expiresAt.trim()
          : null;
      const quota = await syncAiFreeQuotaPro({ username, expiresAt });
      const recordSale = payload.recordSale === true;
      if (recordSale && expiresAt) {
        const planId =
          typeof payload.planId === "string" ? payload.planId.trim().toLowerCase() : "month";
        const priceUsd = Number(payload.priceUsd);
        const months = Number(payload.months);
        try {
          const { recordProSale } = await import("../../database/proSales.js");
          await recordProSale({
            username,
            planId,
            priceUsd: Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : 0,
            months: Number.isFinite(months) && months > 0 ? Math.trunc(months) : 1,
            expiresAt,
          });
        } catch {
          /* sales ledger should not block entitlement sync */
        }
      }
      return respond(res, { ok: true, quota }, 200);
    }

    if (action === "prefs") {
      const modelModeRaw =
        typeof payload.modelMode === "string" ? payload.modelMode.trim().toLowerCase() : "";
      const modelMode: AiModelMode | undefined =
        modelModeRaw === "auto" || modelModeRaw === "tinymodel" || modelModeRaw === "model"
          ? modelModeRaw
          : undefined;
      const modelId =
        payload.modelId === null
          ? null
          : typeof payload.modelId === "string"
            ? payload.modelId
            : undefined;
      const onDemandEnabled =
        typeof payload.onDemandEnabled === "boolean" ? payload.onDemandEnabled : undefined;
      const quota = await updateAiUserPrefs({
        username,
        ...(modelMode !== undefined ? { modelMode } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(onDemandEnabled !== undefined ? { onDemandEnabled } : {}),
      });
      return respond(res, { ok: true, quota, models: AI_TOOLS_MODEL_OPTIONS }, 200);
    }

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
      const { transmit } = await import("../../ai/transmitter.js");
      const chatId = String(payload.chatId ?? "");
      const input = String(payload.input ?? "").trim();
      if (!input) return respond(res, { ok: false, error: "input_required" }, 400);

      const gate = await canStartAiFreeTurn(username);
      if (!gate.ok) {
        return respond(
          res,
          {
            ok: false,
            error: gate.reason ?? "free_ai_limit",
            quota: gate.quota,
          },
          402,
        );
      }

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
      const routePreference = {
        modelMode: gate.quota.modelMode,
        modelId: gate.quota.modelId,
      };
      const ai = await transmit({
        mode: "chat",
        input,
        llmInput: historyBlock
          ? `Previous conversation:\n${historyBlock}\n\nuser: ${input}`
          : input,
        userId: username,
        context: { source: "ai_agent_column", chatId: chat.id },
        instructions:
          "You are the Hyperlinks Space Program AI assistant in the AI & Search column. " +
          "Answer clearly and helpfully. Prefer concise Markdown-friendly prose.",
        routePreference,
      });

      if (!ai.ok || !ai.output_text?.trim()) {
        const code = toPublicAiErrorCode(ai.error ?? "ai_unavailable");
        return respond(
          res,
          { ok: false, error: code, chatId: chat.id },
          code === "ai_capacity" ? 503 : 500,
        );
      }

      const assistant = await insertAiAgentMessage({
        chatId: chat.id,
        role: "assistant",
        content: ai.output_text.trim(),
        model: String(ai.meta?.model ?? ai.provider),
      });

      const usageTotal =
        typeof ai.usage?.total_tokens === "number" && ai.usage.total_tokens > 0
          ? Math.round(ai.usage.total_tokens)
          : estimateTextTokens(input, ai.output_text);
      // Title suggestion is a tiny extra call when a paid backend is configured.
      const titleTokens = 80;
      const billedTokens = usageTotal + titleTokens;

      let nextTitle = chat.title;
      try {
        nextTitle = await suggestTitle(input, chat.title);
      } catch {
        /* title is optional — never fail the turn on provider rate limits */
        nextTitle = input.trim().slice(0, 48) || chat.title;
      }
      const renamed =
        (await renameAiAgentChat({
          chatId: chat.id,
          ownerUsername: username,
          title: nextTitle,
        })) ?? chat;

      const consumed = await consumeAiFreeTokens({ username, tokens: billedTokens });
      const quota = consumed ?? (await getAiFreeQuota(username));

      return respond(
        res,
        {
          ok: true,
          chat: renamed,
          userMessage,
          assistantMessage: assistant,
          model: String(ai.meta?.model ?? ai.provider),
          tokensBilled: billedTokens,
          billingLane: consumed?.billedLane ?? gate.quota.billingLane,
          costUsd: consumed?.costUsd ?? 0,
          quota,
        },
        200,
      );
    }

    return respond(res, { ok: false, error: "unknown_action" }, 400);
  } catch (e: unknown) {
    const code = toPublicAiErrorCode(e);
    return respond(res, { ok: false, error: code }, code === "ai_capacity" ? 503 : 500);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;

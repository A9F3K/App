import { buildApiUrl } from "../../api/_base";

export type TelegramChatListSearchHit = {
  chatId: number;
  title: string;
  peerUserId: number | null;
  peerUsername: string | null;
  chatUsername: string | null;
  chatKind: "private" | "group" | "supergroup" | "channel" | null;
};

export type TelegramChatListSearchResult = {
  ok: true;
  chatIds: number[];
  peerUserIds: number[];
  chats: TelegramChatListSearchHit[];
  directChats: TelegramChatListSearchHit[];
  globalChats: TelegramChatListSearchHit[];
  messageChats: TelegramChatListSearchHit[];
  messageCount: number;
};

export type FetchTelegramChatListSearchResult =
  | TelegramChatListSearchResult
  | { ok: false; error: string };

function normalizeChatKind(
  raw: unknown,
): TelegramChatListSearchHit["chatKind"] {
  if (raw === "private" || raw === "group" || raw === "supergroup" || raw === "channel") {
    return raw;
  }
  return null;
}

function parseSearchHitRows(rawRows: unknown): TelegramChatListSearchHit[] {
  const chats: TelegramChatListSearchHit[] = [];
  if (!Array.isArray(rawRows)) return chats;
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const chatId = Number(row.chatId);
    if (!Number.isFinite(chatId) || chatId === 0) continue;
    const peerUserIdRaw = Number(row.peerUserId);
    chats.push({
      chatId: Math.trunc(chatId),
      title:
        typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : `Chat ${chatId}`,
      peerUserId:
        Number.isFinite(peerUserIdRaw) && peerUserIdRaw !== 0
          ? Math.trunc(peerUserIdRaw)
          : null,
      peerUsername: typeof row.peerUsername === "string" ? row.peerUsername : null,
      chatUsername: typeof row.chatUsername === "string" ? row.chatUsername : null,
      chatKind: normalizeChatKind(row.chatKind),
    });
  }
  return chats;
}

function parseSearchJson(json: {
  chatIds?: unknown;
  peerUserIds?: unknown;
  chats?: unknown;
  directChats?: unknown;
  globalChats?: unknown;
  messageChats?: unknown;
  messageCount?: unknown;
}): TelegramChatListSearchResult {
  const chatIds = Array.isArray(json.chatIds)
    ? json.chatIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id !== 0)
        .map((id) => Math.trunc(id))
    : [];
  const peerUserIds = Array.isArray(json.peerUserIds)
    ? json.peerUserIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id !== 0)
        .map((id) => Math.trunc(id))
    : [];
  const chats = parseSearchHitRows(json.chats);
  const directChats = parseSearchHitRows(json.directChats);
  const globalChats = parseSearchHitRows(json.globalChats);
  const messageChats = parseSearchHitRows(json.messageChats);
  const messageCountRaw = Number(
    json.messageCount ?? (json as { message_count?: unknown }).message_count,
  );
  const messageCount =
    Number.isFinite(messageCountRaw) && messageCountRaw >= 0
      ? Math.trunc(messageCountRaw)
      : 0;
  return {
    ok: true,
    chatIds,
    peerUserIds,
    chats,
    directChats: directChats.length > 0 ? directChats : chats,
    globalChats,
    messageChats,
    messageCount,
  };
}

const EMPTY_SEARCH_RESULT: TelegramChatListSearchResult = {
  ok: true,
  chatIds: [],
  peerUserIds: [],
  chats: [],
  directChats: [],
  globalChats: [],
  messageChats: [],
  messageCount: 0,
};

/** TDLib-backed chat list search (names, usernames, message text, public chats). */
export async function fetchTelegramChatListSearch(
  query: string,
  signal?: AbortSignal,
  options?: { recent?: boolean },
): Promise<FetchTelegramChatListSearchResult> {
  const recent = options?.recent === true;
  const trimmed = query.trim();
  if (!recent && !trimmed) {
    return EMPTY_SEARCH_RESULT;
  }
  const params = new URLSearchParams();
  if (recent) params.set("recent", "1");
  else params.set("query", trimmed);
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-search?${params.toString()}`),
      { method: "GET", credentials: "include", signal },
    );
    const json = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          chatIds?: unknown;
          peerUserIds?: unknown;
          chats?: unknown;
          directChats?: unknown;
          globalChats?: unknown;
          messageChats?: unknown;
          messageCount?: unknown;
          error?: string;
        }
      | null;
    if (!response.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? "search_unavailable" };
    }
    return parseSearchJson(json);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "search_failed" };
  }
}

export async function rememberTelegramFoundChat(chatId: number): Promise<void> {
  if (!Number.isFinite(chatId) || chatId === 0) return;
  try {
    await fetch(buildApiUrl("/api/telegram-messages-search"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Math.trunc(chatId) }),
    });
  } catch {
    /* recents are best-effort */
  }
}

export async function removeTelegramRecentFoundChat(chatId: number): Promise<boolean> {
  if (!Number.isFinite(chatId) || chatId === 0) return false;
  try {
    const params = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-search?${params.toString()}`),
      { method: "DELETE", credentials: "include" },
    );
    const json = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    return response.ok && json?.ok === true;
  } catch {
    return false;
  }
}

export async function clearTelegramRecentFoundChats(): Promise<boolean> {
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-search"), {
      method: "DELETE",
      credentials: "include",
    });
    const json = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    return response.ok && json?.ok === true;
  } catch {
    return false;
  }
}

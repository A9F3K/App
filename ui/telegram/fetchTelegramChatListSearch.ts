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

/** TDLib-backed chat list search (names, usernames, message text, public chats). */
export async function fetchTelegramChatListSearch(
  query: string,
  signal?: AbortSignal,
): Promise<FetchTelegramChatListSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: true, chatIds: [], peerUserIds: [], chats: [] };
  }
  const params = new URLSearchParams({ query: trimmed });
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
          error?: string;
        }
      | null;
    if (!response.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? "search_unavailable" };
    }
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
    const chats: TelegramChatListSearchHit[] = [];
    if (Array.isArray(json.chats)) {
      for (const raw of json.chats) {
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
    }
    return { ok: true, chatIds, peerUserIds, chats };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "search_failed" };
  }
}

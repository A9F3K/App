import { buildApiUrl } from "../../api/_base";

export type TelegramChatListSearchResult = {
  ok: true;
  chatIds: number[];
  peerUserIds: number[];
};

export type FetchTelegramChatListSearchResult =
  | TelegramChatListSearchResult
  | { ok: false; error: string };

/** TDLib-backed chat list search (names, usernames, message text). */
export async function fetchTelegramChatListSearch(
  query: string,
  signal?: AbortSignal,
): Promise<FetchTelegramChatListSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: true, chatIds: [], peerUserIds: [] };
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
    return { ok: true, chatIds, peerUserIds };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "search_failed" };
  }
}

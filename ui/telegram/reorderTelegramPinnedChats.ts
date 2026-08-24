import { buildApiUrl } from "../../api/_base";

export type ReorderTelegramPinnedChatsResult = {
  ok: boolean;
  chat_ids: number[];
  error: string | null;
};

/**
 * Reorder pinned chats through Telegram (`setPinnedChats`).
 * Pass the full pinned list in display order (top → bottom).
 */
export async function reorderTelegramPinnedChats(
  chatIds: number[],
  options?: { archive?: boolean },
): Promise<ReorderTelegramPinnedChatsResult> {
  const ordered = chatIds
    .map((id) => Math.trunc(Number(id)))
    .filter((id, index, arr) => Number.isFinite(id) && id !== 0 && arr.indexOf(id) === index);
  if (ordered.length === 0) {
    return { ok: false, chat_ids: [], error: "chat_ids_required" };
  }

  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-pinned-chats-order"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_ids: ordered,
        archive: Boolean(options?.archive),
      }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      chat_ids?: number[];
      error?: string;
    };
    if (!response.ok || !json.ok) {
      return {
        ok: false,
        chat_ids: ordered,
        error: json.error ?? "reorder_pinned_failed",
      };
    }
    return {
      ok: true,
      chat_ids: Array.isArray(json.chat_ids) ? json.chat_ids.map(Number) : ordered,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      chat_ids: ordered,
      error: err instanceof Error ? err.message : "reorder_pinned_failed",
    };
  }
}

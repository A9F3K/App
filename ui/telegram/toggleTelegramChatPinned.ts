import { buildApiUrl } from "../../api/_base";

export type ToggleTelegramChatPinnedResult = {
  ok: boolean;
  is_pinned: boolean;
  error: string | null;
};

/** Pin or unpin a chat in the main (or archive) chat list. */
export async function toggleTelegramChatPinned(
  chatId: number,
  isPinned: boolean,
): Promise<ToggleTelegramChatPinnedResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, is_pinned: false, error: "invalid_chat_id" };
  }

  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-pin-chat"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, is_pinned: Boolean(isPinned) }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      is_pinned?: boolean;
      error?: string;
    };
    if (!response.ok || !json.ok) {
      return {
        ok: false,
        is_pinned: Boolean(isPinned),
        error: json.error ?? "pin_failed",
      };
    }
    return { ok: true, is_pinned: Boolean(json.is_pinned), error: null };
  } catch (err) {
    return {
      ok: false,
      is_pinned: Boolean(isPinned),
      error: err instanceof Error ? err.message : "pin_failed",
    };
  }
}

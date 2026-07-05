import { buildApiUrl } from "../../api/_base";

export type ViewTelegramChatInboxResult = {
  unread_count: number;
  last_read_inbox_message_id: number | null;
  error: string | null;
};

/** Tell TDLib which inbox messages were viewed (updates authoritative unread_count). */
export async function viewTelegramChatInboxMessages(
  chatId: number,
  messageId: number,
): Promise<ViewTelegramChatInboxResult> {
  const mid = Math.trunc(messageId);
  if (!Number.isFinite(chatId) || chatId === 0 || !Number.isFinite(mid) || mid <= 0) {
    return { unread_count: 0, last_read_inbox_message_id: null, error: "invalid_params" };
  }

  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-view-inbox"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: mid }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      unread_count?: number;
      last_read_inbox_message_id?: number;
      error?: string;
    };
    if (!response.ok || !json.ok) {
      return {
        unread_count: 0,
        last_read_inbox_message_id: null,
        error: json.error ?? "view_inbox_failed",
      };
    }
    const unreadRaw = Number(json.unread_count);
    const lastReadRaw = Number(json.last_read_inbox_message_id);
    return {
      unread_count: Number.isFinite(unreadRaw) && unreadRaw >= 0 ? Math.floor(unreadRaw) : 0,
      last_read_inbox_message_id:
        Number.isFinite(lastReadRaw) && lastReadRaw > 0 ? Math.trunc(lastReadRaw) : null,
      error: null,
    };
  } catch (err) {
    return {
      unread_count: 0,
      last_read_inbox_message_id: null,
      error: err instanceof Error ? err.message : "view_inbox_failed",
    };
  }
}

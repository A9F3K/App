import { buildApiUrl } from "../../api/_base";

export type DeleteTelegramChatMessagesResult =
  | { ok: true; deleted_message_ids: number[] }
  | { ok: false; error: string };

export async function deleteTelegramChatMessages(
  chatId: number,
  messageIds: number[],
): Promise<DeleteTelegramChatMessagesResult> {
  const ids = [
    ...new Set(
      messageIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id)),
    ),
  ];
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  if (ids.length === 0) {
    return { ok: false, error: "message_id_required" };
  }

  const response = await fetch(buildApiUrl("/api/telegram-messages-delete"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_ids: ids,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    deleted_message_ids?: unknown;
    error?: string;
  };

  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "delete_failed" };
  }

  const deleted = Array.isArray(json.deleted_message_ids)
    ? json.deleted_message_ids
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id))
    : ids;

  return { ok: true, deleted_message_ids: deleted };
}

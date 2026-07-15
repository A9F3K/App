import { buildApiUrl } from "../../../api/_base";
import { safeTelegramUserIdForLog } from "../../../shared/appLog";

/** Avatar proxy URL for a voice participant (user or anonymous chat sender). */
export function resolveTelegramUserAvatarUrl(participant: {
  user_id?: number | null;
  chat_id?: number | null;
}): string | null {
  const query = new URLSearchParams();
  const userId = safeTelegramUserIdForLog(participant.user_id);
  const chatId = Number(participant.chat_id);
  if (userId != null) query.set("user_id", String(userId));
  if (Number.isFinite(chatId) && chatId !== 0) query.set("chat_id", String(Math.trunc(chatId)));
  if (!query.toString()) return null;
  return buildApiUrl(`/api/telegram-messages-avatar?${query.toString()}`);
}

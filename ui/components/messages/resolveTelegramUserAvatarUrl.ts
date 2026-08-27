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
  // Prefer user_id alone. Attaching the voice *group* chat_id (or a polluted
  // merge) made the API fall back to that chat's photo when getUser was cold —
  // every missing peer face painted as the group avatar.
  if (userId != null) {
    query.set("user_id", String(userId));
  } else if (Number.isFinite(chatId) && chatId !== 0) {
    query.set("chat_id", String(Math.trunc(chatId)));
  }
  if (!query.toString()) return null;
  return buildApiUrl(`/api/telegram-messages-avatar?${query.toString()}`);
}

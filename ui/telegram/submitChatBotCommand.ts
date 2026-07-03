import { appWarn } from "../../shared/appLog";
import { enrichHistoryMessageDisplay } from "../components/messages/messageChatHistoryTypes";
import { publishOutgoingChatMessage } from "../messageChatOutgoing";
import { sendTelegramChatMessage } from "./sendTelegramChatMessage";

/** Re-send a bot command (e.g. /start) into the open chat. */
export async function submitChatBotCommand(chatId: number, command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!Number.isFinite(chatId) || !trimmed.startsWith("/")) return false;

  const result = await sendTelegramChatMessage(chatId, trimmed, null);
  if (result.ok) {
    publishOutgoingChatMessage(chatId, enrichHistoryMessageDisplay(result.message));
    return true;
  }

  appWarn("[message-bot-command]", String(result.error), { chatId, command: trimmed });
  return false;
}

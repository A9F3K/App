import {
  MESSAGE_CHAT_BODY_PADDING_PX,
  MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX,
} from "./messageChatLayout";

/** Reserve scroll space for the compose pill (+ bottom inset) overlaying the message list. */
export function messageChatBottomOverlayHeightPx(
  pillHeightPx: number = MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX,
): number {
  return MESSAGE_CHAT_BODY_PADDING_PX + pillHeightPx;
}

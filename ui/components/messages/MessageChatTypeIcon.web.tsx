import { FaRobot } from "react-icons/fa";
import { HiMiniNewspaper } from "react-icons/hi2";
import { TbMessagesFilled } from "react-icons/tb";
import type { MessageChatKind } from "./MessageChatRow";

type Props = {
  chatKind?: MessageChatKind | null;
  peerIsBot?: boolean | null;
  color: string;
  size: number;
};

/** Chat-list title type glyph — size matches inline list emojis. */
export function MessageChatTypeIcon({ chatKind, peerIsBot, color, size }: Props) {
  if (chatKind === "channel") {
    return <HiMiniNewspaper color={color} size={size} aria-hidden />;
  }
  if (chatKind === "private" && peerIsBot) {
    return <FaRobot color={color} size={size} aria-hidden />;
  }
  return <TbMessagesFilled color={color} size={size} aria-hidden />;
}

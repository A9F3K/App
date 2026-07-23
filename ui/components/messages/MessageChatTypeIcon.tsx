import Svg, { Path } from "react-native-svg";
import type { MessageChatKind } from "./MessageChatRow";

type Props = {
  chatKind?: MessageChatKind | null;
  peerIsBot?: boolean | null;
  color: string;
  size: number;
};

/** Native fallback for chat-list type glyphs. */
export function MessageChatTypeIcon({ chatKind, peerIsBot, color, size }: Props) {
  if (chatKind === "channel") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 3v2h12V7H6zm0 4v2h8v-2H6zm0 4v2h10v-2H6z"
          fill={color}
        />
      </Svg>
    );
  }
  if (chatKind === "private" && peerIsBot) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 2a2 2 0 0 1 2 2v1h2a3 3 0 0 1 3 3v7a4 4 0 0 1-4 4h-1v2a1 1 0 1 1-2 0v-2H8a4 4 0 0 1-4-4V8a3 3 0 0 1 3-3h2V4a2 2 0 0 1 2-2zm-3 8a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 9 10zm6 0a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 15 10z"
          fill={color}
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 5a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-3.5 2.5A.75.75 0 0 1 4 16V5zm13 3h1a3 3 0 0 1 3 3v6a.75.75 0 0 1-1.2.6L17 15.5v.5a3 3 0 0 1-3 3h-4.5"
        fill={color}
      />
    </Svg>
  );
}

import { RiChatVoiceAiLine } from "react-icons/ri";
import { MdCallEnd, MdMic, MdMicOff } from "react-icons/md";

type Props = {
  color: string;
  size?: number;
  muted?: boolean;
};

/** Web: microphone from `react-icons/md`. */
export function MessageChatMicIcon({ color, size = 20, muted = false }: Props) {
  if (muted) {
    return <MdMicOff color={color} size={size} aria-hidden />;
  }
  return <MdMic color={color} size={size} aria-hidden />;
}

/** Web: leave voice / end call from `react-icons/md`. */
export function MessageChatLeaveVoiceIcon({ color, size = 20 }: Props) {
  return <MdCallEnd color={color} size={size} aria-hidden />;
}

/** Web: start/open voice from `react-icons/ri`. */
export function MessageChatStartVoiceIcon({ color, size = 20 }: Props) {
  return <RiChatVoiceAiLine color={color} size={size} aria-hidden />;
}

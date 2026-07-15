import { MdCallEnd, MdMic } from "react-icons/md";

type Props = {
  color: string;
  size?: number;
};

/** Web: microphone from `react-icons/md`. */
export function MessageChatMicIcon({ color, size = 20 }: Props) {
  return <MdMic color={color} size={size} aria-hidden />;
}

/** Web: leave voice / end call from `react-icons/md`. */
export function MessageChatLeaveVoiceIcon({ color, size = 20 }: Props) {
  return <MdCallEnd color={color} size={size} aria-hidden />;
}

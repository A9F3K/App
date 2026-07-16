import { CiMicrophoneOff, CiMicrophoneOn } from "react-icons/ci";

type Props = {
  speaking: boolean;
  color: string;
  size?: number;
};

/** Web: participant mic state from `react-icons/ci`. */
export function VoiceParticipantStateMicIcon({ speaking, color, size = 20 }: Props) {
  if (speaking) {
    return <CiMicrophoneOn color={color} size={size} aria-hidden />;
  }
  return <CiMicrophoneOff color={color} size={size} aria-hidden />;
}

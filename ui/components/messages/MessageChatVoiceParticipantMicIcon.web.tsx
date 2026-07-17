import { CiMicrophoneOff, CiMicrophoneOn } from "react-icons/ci";

type Props = {
  speaking: boolean;
  muted: boolean;
  color: string;
  size?: number;
};

/** Web: participant mic state from `react-icons/ci` (speaking / on / off). */
export function VoiceParticipantStateMicIcon({
  muted,
  color,
  size = 20,
}: Props) {
  if (muted) {
    return <CiMicrophoneOff color={color} size={size} aria-hidden />;
  }
  return <CiMicrophoneOn color={color} size={size} aria-hidden />;
}

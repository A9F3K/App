import Svg, { Path, Rect } from "react-native-svg";

type IconProps = {
  color: string;
  size?: number;
};

/** Window control from `assets/window_controls/cross.svg` (15×15). */
export function VoiceWindowCrossIcon({ color, size = 15 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 15 15" fill="none">
      <Rect x={14} width={1} height={1} fill={color} />
      <Rect x={12} y={2} width={1} height={1} fill={color} />
      <Rect x={10} y={4} width={1} height={1} fill={color} />
      <Rect x={8} y={6} width={1} height={1} fill={color} />
      <Rect x={6} y={8} width={1} height={1} fill={color} />
      <Rect x={4} y={10} width={1} height={1} fill={color} />
      <Rect x={2} y={12} width={1} height={1} fill={color} />
      <Rect y={14} width={1} height={1} fill={color} />
      <Rect width={1} height={1} fill={color} />
      <Rect x={2} y={2} width={1} height={1} fill={color} />
      <Rect x={4} y={4} width={1} height={1} fill={color} />
      <Rect x={6} y={6} width={1} height={1} fill={color} />
      <Rect x={8} y={8} width={1} height={1} fill={color} />
      <Rect x={10} y={10} width={1} height={1} fill={color} />
      <Rect x={12} y={12} width={1} height={1} fill={color} />
      <Rect x={14} y={14} width={1} height={1} fill={color} />
    </Svg>
  );
}

/** Window control from `assets/window_controls/size.svg` (15×15). */
export function VoiceWindowSizeIcon({ color, size = 15 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 15 15" fill="none">
      <Rect x={14} width={1} height={1} fill={color} />
      <Rect x={14} y={2} width={1} height={1} fill={color} />
      <Rect x={14} y={4} width={1} height={1} fill={color} />
      <Rect x={14} y={6} width={1} height={1} fill={color} />
      <Rect x={14} y={8} width={1} height={1} fill={color} />
      <Rect x={14} y={10} width={1} height={1} fill={color} />
      <Rect x={14} y={12} width={1} height={1} fill={color} />
      <Rect y={14} width={1} height={1} fill={color} />
      <Rect x={2} y={14} width={1} height={1} fill={color} />
      <Rect x={4} y={14} width={1} height={1} fill={color} />
      <Rect x={6} y={14} width={1} height={1} fill={color} />
      <Rect x={8} y={14} width={1} height={1} fill={color} />
      <Rect x={10} y={14} width={1} height={1} fill={color} />
      <Rect x={12} y={14} width={1} height={1} fill={color} />
      <Rect y={12} width={1} height={1} fill={color} />
      <Rect y={10} width={1} height={1} fill={color} />
      <Rect y={8} width={1} height={1} fill={color} />
      <Rect y={6} width={1} height={1} fill={color} />
      <Rect y={4} width={1} height={1} fill={color} />
      <Rect y={2} width={1} height={1} fill={color} />
      <Rect width={1} height={1} fill={color} />
      <Rect x={2} width={1} height={1} fill={color} />
      <Rect x={4} width={1} height={1} fill={color} />
      <Rect x={6} width={1} height={1} fill={color} />
      <Rect x={8} width={1} height={1} fill={color} />
      <Rect x={10} width={1} height={1} fill={color} />
      <Rect x={12} width={1} height={1} fill={color} />
      <Rect x={14} y={14} width={1} height={1} fill={color} />
    </Svg>
  );
}

/** Window control from `assets/window_controls/tray.svg` (15×1). */
export function VoiceWindowTrayIcon({ color, size = 15 }: IconProps) {
  return (
    <Svg width={size} height={Math.max(1, Math.round(size / 15))} viewBox="0 0 15 1" fill="none">
      <Rect width={1} height={1} fill={color} />
      <Rect x={2} width={1} height={1} fill={color} />
      <Rect x={4} width={1} height={1} fill={color} />
      <Rect x={6} width={1} height={1} fill={color} />
      <Rect x={8} width={1} height={1} fill={color} />
      <Rect x={10} width={1} height={1} fill={color} />
      <Rect x={12} width={1} height={1} fill={color} />
      <Rect x={14} width={1} height={1} fill={color} />
    </Svg>
  );
}

/** Participant / control mic from `assets/voice_controls/status.svg` (20×20). */
export function VoiceStatusMicIcon({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M9.93294 13.3666C8.09461 13.3666 6.59961 11.8708 6.59961 10.0333V5.03328C6.59961 3.19578 8.09461 1.69995 9.93294 1.69995C11.7713 1.69995 13.2663 3.19578 13.2663 5.03328V10.0333C13.2663 11.8708 11.7713 13.3666 9.93294 13.3666ZM9.93294 3.36662C9.01378 3.36662 8.26628 4.11328 8.26628 5.03328V10.0333C8.26628 10.9533 9.01378 11.7 9.93294 11.7C10.8521 11.7 11.5996 10.9533 11.5996 10.0333V5.03328C11.5996 4.11328 10.8521 3.36662 9.93294 3.36662ZM15.7663 10.0333V8.36662C15.7663 7.90578 15.3938 7.53328 14.9329 7.53328C14.4721 7.53328 14.0996 7.90578 14.0996 8.36662V10.0333C14.0996 12.3308 12.2304 14.2 9.93294 14.2C7.63544 14.2 5.76628 12.3308 5.76628 10.0333V8.36662C5.76628 7.90578 5.39378 7.53328 4.93294 7.53328C4.47211 7.53328 4.09961 7.90578 4.09961 8.36662V10.0333C4.09961 12.9666 6.27711 15.3933 9.09961 15.8V16.7H6.59961C6.13878 16.7 5.76628 17.0725 5.76628 17.5333C5.76628 17.9941 6.13878 18.3666 6.59961 18.3666H13.2663C13.7271 18.3666 14.0996 17.9941 14.0996 17.5333C14.0996 17.0725 13.7271 16.7 13.2663 16.7H10.7663V15.8C13.5888 15.3933 15.7663 12.9666 15.7663 10.0333Z"
        fill={color}
      />
    </Svg>
  );
}

/** Control from `assets/voice_controls/camera.svg` (20×20). Pass muted for off glyph. */
export function VoiceCameraIcon({
  color,
  size = 20,
  muted = false,
}: IconProps & { muted?: boolean }) {
  if (muted) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M21 6.5l-4 2.5V7c0-1.1-.9-2-2-2H7.82L21 18.18V6.5zM3.27 2L2 3.27 4.73 6H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h12c.21 0 .39-.04.57-.1L19.73 21 21 19.73 3.27 2z"
          fill={color}
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M11.6736 3.30005H1.65972C0.743056 3.30005 0 4.0431 0 4.95977V14.9737C0 15.8903 0.743056 16.6334 1.65972 16.6334H11.6736C12.5903 16.6334 13.3333 15.8903 13.3333 14.9737V4.95977C13.3333 4.0431 12.5903 3.30005 11.6736 3.30005ZM18.25 4.60908L14.4444 7.23408V12.6994L18.25 15.3209C18.9861 15.8278 20 15.3105 20 14.425V5.50491C20 4.62297 18.9896 4.10213 18.25 4.60908Z"
        fill={color}
      />
    </Svg>
  );
}

/** Control from `assets/voice_controls/drop.svg` (20×20). */
export function VoiceDropIcon({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M19.8712 10.3C20.0267 11.3838 20.1287 12.8663 19.6448 13.4338C18.845 14.3725 13.7814 14.3725 13.7814 12.495C13.7814 11.55 14.6147 10.93 13.815 9.9913C13.0289 9.0688 11.6183 9.0538 10.0499 9.05255C8.48138 9.0513 7.07211 9.06755 6.28476 9.9913C5.48497 10.93 6.31834 11.55 6.31834 12.495C6.31834 14.3713 1.25467 14.3713 0.454883 13.4338C-0.0289707 12.8663 0.0730241 11.3838 0.228504 10.3C0.347913 9.5763 0.650165 8.7963 1.61912 7.80005C3.07192 6.43755 5.26978 5.32505 9.97274 5.30005C9.99886 5.30005 10.025 5.30005 10.0511 5.30005C10.0772 5.30005 10.1021 5.30005 10.1295 5.30005C14.8324 5.3238 17.0303 6.43755 18.4831 7.80005C19.4508 8.7963 19.7543 9.5763 19.8737 10.3H19.8712Z"
        fill={color}
      />
    </Svg>
  );
}

/** Control from `assets/voice_controls/messages.svg` (20×21). */
export function VoiceMessagesIcon({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 21" fill="none">
      <Path
        d="M2.5 0.5H17.5C18.58 0.5 19.4999 1.42999 19.5 2.625V14.4385C19.4998 15.6334 18.5799 16.5635 17.5 16.5635H11.9092L11.7725 16.6709L6.94434 20.4736C6.90293 20.5055 6.8588 20.5054 6.82617 20.4883C6.78868 20.4686 6.75003 20.4192 6.75 20.3447V16.5635H2.5C1.42007 16.5635 0.500182 15.6334 0.5 14.4385V2.625C0.500058 1.42999 1.42 0.5 2.5 0.5Z"
        stroke={color}
      />
    </Svg>
  );
}

/** Control from `assets/voice_controls/mic.svg` (20×20). Pass muted for off glyph. */
export function VoiceMicControlIcon({
  color,
  size = 20,
  muted = false,
}: IconProps & { muted?: boolean }) {
  if (muted) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"
          fill={color}
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M9.97461 13.75C12.0457 13.75 13.7246 12.0711 13.7246 10V3.75C13.7246 1.67891 12.0457 0 9.97461 0C7.90352 0 6.22461 1.67891 6.22461 3.75V10C6.22461 12.0711 7.90352 13.75 9.97461 13.75ZM16.2246 7.5H15.5996C15.2543 7.5 14.9746 7.77969 14.9746 8.125V10C14.9746 12.9219 12.4555 15.2664 9.475 14.9758C6.87735 14.7223 4.97461 12.3871 4.97461 9.77735V8.125C4.97461 7.77969 4.69492 7.5 4.34961 7.5H3.72461C3.3793 7.5 3.09961 7.77969 3.09961 8.125V9.69375C3.09961 13.1953 5.59844 16.3168 9.03711 16.791V18.125H6.84961C6.5043 18.125 6.22461 18.4047 6.22461 18.75V19.375C6.22461 19.7203 6.5043 20 6.84961 20H13.0996C13.4449 20 13.7246 19.7203 13.7246 19.375V18.75C13.7246 18.4047 13.4449 18.125 13.0996 18.125H10.9121V16.8059C14.2602 16.3465 16.8496 13.4727 16.8496 10V8.125C16.8496 7.77969 16.5699 7.5 16.2246 7.5Z"
        fill={color}
      />
    </Svg>
  );
}

/** Control from `assets/voice_controls/more.svg` (20×20). */
export function VoiceMoreIcon({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Rect x={8} width={4} height={4} fill={color} />
      <Rect x={8} y={16} width={4} height={4} fill={color} />
      <Rect x={8} y={8} width={4} height={4} fill={color} />
    </Svg>
  );
}

/** Screen-share / presentation control (monitor with arrow). Pass muted for off glyph. */
export function VoiceScreenShareIcon({
  color,
  size = 20,
  active = false,
  muted = false,
}: IconProps & { active?: boolean; muted?: boolean }) {
  if (muted) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M21.19 21.19L2.81 2.81 1.39 4.22 3 5.83V15c0 1.1.9 2 2 2h4v2h8v-2h.17l3.61 3.61 1.41-1.42zM5 15V7.83l7.77 7.77H5zM20.97 15.5l-.47-.47V5H8.83l2 2H19v8.17l1.97 1.97c.5-.28.83-.81.83-1.4V5c0-1.1-.9-2-2-2H6.83l2 2h11.14z"
          fill={color}
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 3H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h4v2h8v-2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12H4V5h16v10z"
        fill={color}
      />
      {active ? (
        <Path d="M8 9.5h8v2H8v-2z" fill={color} />
      ) : (
        <Path
          d="M12 8.2l2.6 2.6-1.1 1.1-1-1V14h-1.5v-3.1l-1 1-1.1-1.1L12 8.2z"
          fill={color}
        />
      )}
    </Svg>
  );
}

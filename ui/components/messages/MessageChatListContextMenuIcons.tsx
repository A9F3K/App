import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg";

type IconProps = { color: string; size?: number };

const SW = 1.6;

export function ChatMenuOpenWindowIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="6.5" width="13" height="13" rx="1.5" stroke={color} strokeWidth={SW} />
      <Path d="M9.5 4.5h11v11" stroke={color} strokeWidth={SW} strokeLinejoin="round" />
    </Svg>
  );
}

export function ChatMenuArchiveIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7.5h16v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V7.5Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
      <Path d="M4 7.5 6.2 4h11.6L20 7.5" stroke={color} strokeWidth={SW} strokeLinejoin="round" />
      <Path d="M12 11v6.5" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Path d="M9.2 14.8 12 17.5l2.8-2.7" stroke={color} strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChatMenuPinIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9.2 13.8 6 17l1 1 3.2-3.2"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M8.8 10.2 13.8 5.2l5 5-5 5-5-5Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChatMenuUnpinIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9.2 13.8 6 17l1 1 3.2-3.2"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M8.8 10.2 13.8 5.2l5 5-5 5-5-5Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
      <Line x1="4.5" y1="4.5" x2="19.5" y2="19.5" stroke={color} strokeWidth={SW} strokeLinecap="round" />
    </Svg>
  );
}

export function ChatMenuProfileIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={SW} />
      <Circle cx="12" cy="10" r="2.6" stroke={color} strokeWidth={SW} />
      <Path
        d="M7.2 17.4c1.1-2 3-3 4.8-3s3.7 1 4.8 3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ChatMenuGroupInfoIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={SW} />
      <Path d="M12 11v6" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Circle cx="12" cy="8" r="1" fill={color} />
    </Svg>
  );
}

export function ChatMenuUnmuteIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4.5 10h2.4l4.2-3.4c.5-.4 1.2-.1 1.2.5v10.8c0 .6-.7.9-1.2.5L6.9 15H4.5A1.5 1.5 0 0 1 3 13.5v-2A1.5 1.5 0 0 1 4.5 10Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
      <Path
        d="M16.2 9.2c1.1.9 1.8 2.1 1.8 3.3s-.7 2.4-1.8 3.3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ChatMenuMarkReadIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={SW} />
      <Polyline
        points="8,12.2 11,15.2 16.2 9.4"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChatMenuMarkUnreadIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 7.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.5V9A1.5 1.5 0 0 1 5 7.5Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
      <Circle cx="12" cy="12.5" r="1.35" fill={color} />
    </Svg>
  );
}

export function ChatMenuBlockIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8.2 11.2c-.2-1.6.7-3.2 2.3-3.8 1.4-.5 2.9.1 3.7 1.3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
      <Path
        d="M7 13.2c.2 3.2 2.4 5.3 5 5.3 1.2 0 2.3-.4 3.2-1.1"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
      <Path
        d="M14.8 8.2c1.6.6 2.6 2.2 2.4 3.9-.1.8-.4 1.5-.9 2.1"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ChatMenuClearHistoryIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 16.5c2.4-3.8 5.2-6.2 9.2-8.6 1.3-.8 2.6.6 1.8 1.8-2.4 4-4.8 6.8-8.6 9.2-1.2.8-2.6-.5-1.8-1.8 1.1-1.7 2.3-3.2 3.6-4.6"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ChatMenuDeleteIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M5 7h14" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" stroke={color} strokeWidth={SW} />
      <Path
        d="M7 7l.8 12.2A1.5 1.5 0 0 0 9.3 20.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChatMenuLeaveIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M10 5.5H7A1.5 1.5 0 0 0 5.5 7v10A1.5 1.5 0 0 0 7 18.5h3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
      <Path d="M10 12h9" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Path d="M16.5 8.5 20 12l-3.5 3.5" stroke={color} strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

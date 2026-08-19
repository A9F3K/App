import Svg, { Circle, Path, Rect } from "react-native-svg";

type IconProps = { color: string; size?: number };

export function SideMenuProfileIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Circle cx="11" cy="11" r="9.25" stroke={color} strokeWidth={1.5} />
      <Circle cx="11" cy="9" r="3.25" stroke={color} strokeWidth={1.5} />
      <Path
        d="M5.5 17.5C6.6 14.8 8.6 13.5 11 13.5C13.4 13.5 15.4 14.8 16.5 17.5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function SideMenuWalletIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Rect x="3" y="6" width="16" height="11" rx="2" stroke={color} strokeWidth={1.5} />
      <Path d="M3 9H19" stroke={color} strokeWidth={1.5} />
      <Circle cx="15.5" cy="12.5" r="1.25" fill={color} />
    </Svg>
  );
}

export function SideMenuGroupIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Circle cx="8" cy="9.5" r="2.75" stroke={color} strokeWidth={1.5} />
      <Circle cx="14" cy="9.5" r="2.75" stroke={color} strokeWidth={1.5} />
      <Path d="M4 17C4.8 14.8 6.4 13.5 8 13.5" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <Path d="M14 13.5C15.6 13.5 17.2 14.8 18 17" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <Circle cx="11" cy="8" r="2.25" stroke={color} strokeWidth={1.5} />
      <Path d="M6.5 16.5C7.4 14.3 9 13 11 13" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

export function SideMenuChannelIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path
        d="M4 8.5L18 4V14L4 17.5V8.5Z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <Path d="M9 10.5V15.5L13 13.8V8.8L9 10.5Z" fill={color} />
    </Svg>
  );
}

export function SideMenuContactsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Circle cx="11" cy="8.5" r="3.25" stroke={color} strokeWidth={1.5} />
      <Path
        d="M5 17.5C6.2 14.5 8.3 13 11 13C13.7 13 15.8 14.5 17 17.5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function SideMenuCallsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path
        d="M6.5 8.5C7.8 11.2 10.8 14.2 13.5 15.5L15.5 13.5C15.8 13.2 16.3 13.1 16.7 13.3C17.8 13.8 19.1 14.1 20.3 14.1C20.7 14.1 21 14.4 21 14.8V17.8C21 18.2 20.7 18.5 20.3 18.5C11.2 18.5 3.5 10.8 3.5 1.7C3.5 1.3 3.8 1 4.2 1H7.2C7.6 1 7.9 1.3 7.9 1.7C7.9 2.9 8.2 4.2 8.7 5.3C8.9 5.7 8.8 6.2 8.5 6.5L6.5 8.5Z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function SideMenuSavedIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path
        d="M6 4H16V18L11 15L6 18V4Z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function SideMenuAddAccountIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Circle cx="11" cy="11" r="8.25" stroke={color} strokeWidth={1.5} />
      <Path d="M11 7V15M7 11H15" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

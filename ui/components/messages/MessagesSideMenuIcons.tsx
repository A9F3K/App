import Svg, { Circle, Path, Rect } from "react-native-svg";

type IconProps = { color: string; size?: number };

const SW = 1.75;

/** Profile — person in a circle (standard account glyph). */
export function SideMenuProfileIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={SW} />
      <Circle cx="12" cy="10" r="3" stroke={color} strokeWidth={SW} />
      <Path
        d="M6.8 18.2c1.2-2.2 3.1-3.2 5.2-3.2s4 1 5.2 3.2"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Wallet — rounded card with a clasp. */
export function SideMenuWalletIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="6.5" width="17" height="12" rx="2.5" stroke={color} strokeWidth={SW} />
      <Path d="M3.5 10h17" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Circle cx="16.5" cy="14" r="1.25" fill={color} />
    </Svg>
  );
}

/** New group — two people (simple, non-overlapping). */
export function SideMenuGroupIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="9" cy="9" r="2.75" stroke={color} strokeWidth={SW} />
      <Circle cx="16" cy="9.5" r="2.25" stroke={color} strokeWidth={SW} />
      <Path
        d="M4.5 18c.9-2.4 2.7-3.5 4.5-3.5s3.6 1.1 4.5 3.5"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
      <Path
        d="M13.2 17.6c.7-1.7 2-2.6 3.5-2.6 1.4 0 2.6.8 3.3 2.3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** New channel — classic megaphone. */
export function SideMenuChannelIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 10h2.2l4.3-3.8c.5-.4 1.2-.1 1.2.5v11.6c0 .6-.7.9-1.2.5L7.2 15H5a1.5 1.5 0 0 1-1.5-1.5v-2A1.5 1.5 0 0 1 5 10Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
      <Path
        d="M15.5 9c1.1.9 1.8 2.1 1.8 3s-.7 2.1-1.8 3"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
      <Path
        d="M17.8 6.8c2 1.5 3.2 3.5 3.2 5.2s-1.2 3.7-3.2 5.2"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Contacts — single person. */
export function SideMenuContactsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="9" r="3.25" stroke={color} strokeWidth={SW} />
      <Path
        d="M5.5 19c1.3-3 3.5-4.5 6.5-4.5s5.2 1.5 6.5 4.5"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Calls — standard handset (Lucide-style). */
export function SideMenuCallsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c1.2.34 2 .57 2.81.7A2 2 0 0 1 22 16.92z"
        stroke={color}
        strokeWidth={SW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Saved messages — bookmark. */
export function SideMenuSavedIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 4.5h10v15l-5-3.2-5 3.2v-15Z"
        stroke={color}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Messenger settings — horizontal sliders (not the app settings cog).
 * Reads clearly at 22px and stays distinct from the rotating Settings gear elsewhere.
 */
export function SideMenuMessengerSettingsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 7h16" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Path d="M4 12h16" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Path d="M4 17h16" stroke={color} strokeWidth={SW} strokeLinecap="round" />
      <Circle cx="9" cy="7" r="2.25" fill={color} />
      <Circle cx="15" cy="12" r="2.25" fill={color} />
      <Circle cx="11" cy="17" r="2.25" fill={color} />
    </Svg>
  );
}

/** Add account — plus in a circle. */
export function SideMenuAddAccountIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={SW} />
      <Path d="M12 8v8M8 12h8" stroke={color} strokeWidth={SW} strokeLinecap="round" />
    </Svg>
  );
}

import Svg, { Circle, Path, Rect } from "react-native-svg";

export type ProFeatureIconId =
  | "aiModels"
  | "proxyVpn"
  | "nftCollection"
  | "cashback"
  | "blockchainChat"
  | "unlimitedAccounts"
  | "menuCustomization";

type Props = {
  id: ProFeatureIconId;
  color: string;
  size?: number;
};

/** Unique monoline icon per Pro Access feature. */
export function ProFeatureIcon({ id, color, size = 24 }: Props) {
  switch (id) {
    case "aiModels":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3.5v2.2M12 18.3v2.2M4.8 7.2l1.6 1.6M17.6 15.2l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 16.8l1.6-1.6M17.6 8.8l1.6-1.6"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
          <Circle cx="12" cy="12" r="3.4" stroke={color} strokeWidth={1.7} />
        </Svg>
      );
    case "proxyVpn":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3.5 18.5 6.2v5.1c0 4.1-2.7 7.1-6.5 8.7-3.8-1.6-6.5-4.6-6.5-8.7V6.2L12 3.5Z"
            stroke={color}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
          <Path
            d="M9.2 12.1 11.1 14l3.7-4"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "nftCollection":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M7.2 8.2 12 4.8l4.8 3.4v7.6L12 19.2l-4.8-3.4V8.2Z"
            stroke={color}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
          <Path d="M12 4.8v14.4M7.2 8.2 16.8 15.8M16.8 8.2 7.2 15.8" stroke={color} strokeWidth={1.35} />
        </Svg>
      );
    case "cashback":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.7} />
          {/* Classic $: S body + stem with clear top/bottom stems past the curves. */}
          <Path
            d="M14.85 8.35c-.55-.85-1.45-1.35-2.55-1.35-1.7 0-2.95 1-2.95 2.35 0 1.25.95 1.95 2.55 2.35l.7.18c1.55.4 2.55 1.05 2.55 2.45 0 1.45-1.3 2.55-3.15 2.55-1.25 0-2.3-.55-2.95-1.5"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M12 5.85v12.3"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </Svg>
      );
    case "blockchainChat":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M5.2 6.2h9.4a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H9.1L5.2 18V6.2Z"
            stroke={color}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
          <Circle cx="8.4" cy="10.4" r="0.9" fill={color} />
          <Circle cx="11.2" cy="10.4" r="0.9" fill={color} />
          <Circle cx="14" cy="10.4" r="0.9" fill={color} />
          <Path d="M16.8 11.8h1.5a1.5 1.5 0 0 1 1.5 1.5v2.2l-1.8 1.5v-1.2H16" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        </Svg>
      );
    case "unlimitedAccounts":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx="9" cy="8.2" r="2.4" stroke={color} strokeWidth={1.7} />
          <Circle cx="16.2" cy="9" r="2" stroke={color} strokeWidth={1.55} />
          <Path
            d="M4.4 17.6c.5-2.4 2.3-3.7 4.6-3.7s4.1 1.3 4.6 3.7"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
          <Path
            d="M13.6 16.8c.4-1.6 1.6-2.5 3.1-2.5 1.3 0 2.4.7 2.9 1.9"
            stroke={color}
            strokeWidth={1.55}
            strokeLinecap="round"
          />
        </Svg>
      );
    case "menuCustomization":
      // Horizontal upper-menu strip: tray + side-by-side slots (matches app nav, not a vertical list).
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Rect x="2.6" y="8.1" width="18.8" height="7.8" rx="2.2" stroke={color} strokeWidth={1.7} />
          <Rect x="4.4" y="10" width="3.2" height="4" rx="1" stroke={color} strokeWidth={1.45} />
          <Rect x="8.4" y="10" width="3.2" height="4" rx="1" stroke={color} strokeWidth={1.45} />
          <Rect x="12.4" y="10" width="3.2" height="4" rx="1" fill={color} stroke={color} strokeWidth={1.45} />
          <Rect x="16.4" y="10" width="3.2" height="4" rx="1" stroke={color} strokeWidth={1.45} />
        </Svg>
      );
    default:
      return null;
  }
}

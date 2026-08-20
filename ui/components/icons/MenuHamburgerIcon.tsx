import Svg, { Rect } from "react-native-svg";

/** Three-bar hamburger from `public/menu.svg` (20×13 viewBox). */
const VIEW_W = 20;
const VIEW_H = 13;

export function MenuHamburgerIcon({ color, size = 13 }: { color: string; size?: number }) {
  const height = size;
  const width = (VIEW_W / VIEW_H) * size;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} fill="none">
      <Rect width={VIEW_W} height={1} fill={color} />
      <Rect y={6} width={VIEW_W} height={1} fill={color} />
      <Rect y={12} width={VIEW_W} height={1} fill={color} />
    </Svg>
  );
}

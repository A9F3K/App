import { View } from "react-native";

/** Pixel hamburger from `public/menu.svg` (15×13 viewBox, 1px rects). */
const MENU_ICON_RECTS: readonly { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 4, y: 0 },
  { x: 6, y: 0 },
  { x: 8, y: 0 },
  { x: 10, y: 0 },
  { x: 12, y: 0 },
  { x: 14, y: 0 },
  { x: 0, y: 6 },
  { x: 2, y: 6 },
  { x: 4, y: 6 },
  { x: 6, y: 6 },
  { x: 8, y: 6 },
  { x: 10, y: 6 },
  { x: 12, y: 6 },
  { x: 14, y: 6 },
  { x: 0, y: 12 },
  { x: 2, y: 12 },
  { x: 4, y: 12 },
  { x: 6, y: 12 },
  { x: 8, y: 12 },
  { x: 10, y: 12 },
  { x: 12, y: 12 },
  { x: 14, y: 12 },
];

const VIEW_W = 15;
const VIEW_H = 13;

export function MenuHamburgerIcon({ color, size = 13 }: { color: string; size?: number }) {
  const scale = size / VIEW_H;
  const width = VIEW_W * scale;
  const height = size;
  const dot = scale;

  return (
    <View style={{ width, height, position: "relative" }}>
      {MENU_ICON_RECTS.map(({ x, y }) => (
        <View
          key={`${x}-${y}`}
          style={{
            position: "absolute",
            left: x * scale,
            top: y * scale,
            width: dot,
            height: dot,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

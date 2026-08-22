import type { ReactNode } from "react";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

type IconProps = {
  color: string;
  size?: number;
};

function Root({
  size = 16,
  children,
}: {
  size?: number;
  children: ReactNode;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      {children}
    </Svg>
  );
}

export function MusicPrevIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path d="M3 4v8M13 4L7 8l6 4V4Z" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
    </Root>
  );
}

export function MusicNextIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path d="M13 4v8M3 4l6 4-6 4V4Z" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
    </Root>
  );
}

export function MusicPlayIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path d="M5 3.5l8 4.5-8 4.5V3.5Z" fill={color} />
    </Root>
  );
}

export function MusicPauseIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Rect x={4.5} y={3.5} width={2.2} height={9} rx={0.4} fill={color} />
      <Rect x={9.3} y={3.5} width={2.2} height={9} rx={0.4} fill={color} />
    </Root>
  );
}

export function MusicVolumeIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path
        d="M3.5 6.2h2.1L8.4 4.2v7.6L5.6 9.8H3.5V6.2Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <Path d="M10.2 6.1c.8.7.8 3.1 0 3.8" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path d="M11.8 4.8c1.5 1.4 1.5 5 0 6.4" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    </Root>
  );
}

export function MusicShuffleIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path
        d="M2.5 5h3.2l6.3 6H14M2.5 11h3.2l1.6-1.5M10.2 6.4L11.7 5H14"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M12.4 3.6L14.2 5 12.4 6.4" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d="M12.4 9.6L14.2 11 12.4 12.4" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
    </Root>
  );
}

export function MusicLoopIcon({
  color,
  size,
  mode,
}: IconProps & { mode: "off" | "one" | "all" }) {
  return (
    <Root size={size}>
      <Path
        d="M4.2 6.2V5.4c0-.7.6-1.3 1.3-1.3h6.2l-1.3-1.3M11.8 9.8v.8c0 .7-.6 1.3-1.3 1.3H4.3l1.3 1.3"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={mode === "off" ? 0.45 : 1}
      />
      {mode === "one" ? (
        <SvgText
          x={8}
          y={9.6}
          fill={color}
          fontSize={6.5}
          fontWeight="700"
          textAnchor="middle"
        >
          1
        </SvgText>
      ) : null}
    </Root>
  );
}

export function MusicCloseIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path d="M4 4l8 8M12 4l-8 8" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Root>
  );
}

export function MusicBackChevronIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Path d="M10.5 3.5L5 8l5.5 4.5" stroke={color} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </Root>
  );
}

export function MusicReorderIcon({ color, size }: IconProps) {
  return (
    <Root size={size}>
      <Rect x={3} y={4} width={10} height={1.3} rx={0.4} fill={color} />
      <Rect x={3} y={7.35} width={10} height={1.3} rx={0.4} fill={color} />
      <Rect x={3} y={10.7} width={10} height={1.3} rx={0.4} fill={color} />
    </Root>
  );
}

import { createElement } from "react";
import { FONT_UI_SANS_SEMIBOLD, WEB_UI_SANS_STACK } from "../../fonts";
import type { ThemeColors, ThemeName } from "../../theme";
import {
  avatarFallback3dCssVars,
  chatAvatarFallbackBackground,
  colorsForAvatarInitials,
} from "./chatAvatarInitials";

type Props = {
  initials: string[];
  sizePx: number;
  colors: ThemeColors;
  scheme: ThemeName;
  /** Fill the parent slot (keeps `sizePx` for letter sizing). */
  fill?: boolean;
};

function phaseOffsetSec(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return -((h % 17) / 17) * 4;
}

/**
 * Web null-avatar chip: extruded letters + soft luminous bg.
 * Intentionally avoids preserve-3d / translateZ / will-change (those punch
 * through photo overlays and thrash the compositor in long chat lists).
 */
export function ChatAvatarFallback({ initials, sizePx, colors, scheme, fill = false }: Props) {
  const backgroundColor = chatAvatarFallbackBackground(colors, scheme);
  const letterColors = colorsForAvatarInitials(initials, scheme);
  const accent = letterColors[0] ?? null;
  const cssVars = avatarFallback3dCssVars(accent, backgroundColor, scheme);
  const fontSize = initials.length > 1 ? Math.round(sizePx * 0.36) : Math.round(sizePx * 0.44);
  const seed = initials.join("") || "·";
  const baseDelay = phaseOffsetSec(seed);

  const frameStyle: Record<string, string | number> = {
    ...(fill
      ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
      : { width: sizePx, height: sizePx }),
    borderRadius: 0,
    overflow: "hidden",
    ...cssVars,
  };

  const letters =
    initials.length === 0
      ? null
      : createElement(
          "div",
          { className: "hsp-avatar-fallback-3d-scene" },
          ...initials.map((letter, index) =>
            createElement(
              "span",
              {
                key: `${letter}-${index}`,
                className: "hsp-avatar-fallback-3d-letter",
                style: {
                  fontSize,
                  lineHeight: `${fontSize + 2}px`,
                  fontFamily: `${FONT_UI_SANS_SEMIBOLD}, ${WEB_UI_SANS_STACK}`,
                  fontWeight: 600,
                  animationDelay: `${baseDelay - index * 0.22}s`,
                },
              },
              letter,
            ),
          ),
        );

  return createElement(
    "div",
    { className: "hsp-avatar-fallback-3d", style: frameStyle },
    createElement("div", {
      className: "hsp-avatar-fallback-3d-bg",
      style: { animationDelay: `${baseDelay * 0.5}s` },
    }),
    letters,
  );
}

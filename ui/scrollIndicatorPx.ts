import { PixelRatio, Platform } from "react-native";

/**
 * Snap layout coords to the device pixel grid so a 1px-wide overlay doesn’t sit on half-pixels and blur.
 */
export function snapScrollIndicatorCoordPx(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      const dpr = window.devicePixelRatio;
      return Math.round(n * dpr) / dpr;
    }
    return Math.round(n);
  }
  return PixelRatio.roundToNearestPixel(n);
}

/**
 * **Max** fraction of the scrollbar **track** the thumb may span (horizontal width or vertical height).
 * Matches the home nav strip; keeps tiny overflows from a full-track “dead” thumb.
 */
export const SCROLL_INDICATOR_THUMB_MAX_TRACK_FRAC = 0.32;

/**
 * **Min** thumb span along the scroll axis (px), not a percentage — e.g. on a 375px-wide track,
 * 4px ≈ 1.07%. Caps at `trackSpan - 1` when the track is narrow.
 */
export const SCROLL_INDICATOR_THUMB_MIN_PX = 4;

/** Chat message list thumb floor (tdesktop `st::minHeight` ≈ 20px). */
export const CHAT_SCROLL_INDICATOR_THUMB_MIN_PX = 20;

/** Pin thumb to track ends when scroll offset is within this many px of 0 / max. */
export const SCROLL_INDICATOR_SCROLL_EPS = 2;

/** Extra hit area (px) perpendicular to the scroll axis for dragging hairline thumbs. */
export const SCROLL_INDICATOR_DRAG_HIT_INSET_PX = 3;

/**
 * Right inset so the 1px scroll thumb sits on a 1px chrome border (floating dialogs, side menu).
 * Negative = overhang into the border; pair with `scrollIndicatorOverlaySeam={false}`.
 */
export const SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX = -1;

/**
 * Light-theme portaled thumb width (px) when flush with the viewport right edge.
 * Hairline thumbs clip against black letterboxing outside the app frame.
 */
export const SCROLL_INDICATOR_VIEWPORT_EDGE_THUMB_PX = 3;

/** True when a portaled vertical thumb anchor sits on the viewport's right edge. */
export function isScrollIndicatorAtViewportRightEdge(rightPx: number): boolean {
  if (typeof window === "undefined") return false;
  const viewportW = window.visualViewport?.width ?? window.innerWidth;
  if (!(viewportW > 0)) return false;
  return Math.abs(rightPx - viewportW) <= 1.5;
}

/** Map thumb position on track (px) to scroll offset (px). Inverse of thumb offset math. */
export function scrollOffsetFromThumbPosition(
  thumbPos: number,
  trackSpan: number,
  thumbSpan: number,
  scrollRange: number,
): number {
  if (scrollRange <= 0 || trackSpan <= 0) return 0;
  const maxTravel = Math.max(0, trackSpan - thumbSpan);
  const clamped = Math.max(0, Math.min(thumbPos, maxTravel));
  if (clamped <= SCROLL_INDICATOR_SCROLL_EPS) return 0;
  if (clamped >= maxTravel - SCROLL_INDICATOR_SCROLL_EPS) return scrollRange;
  if (maxTravel <= 0) return 0;
  return (clamped / maxTravel) * scrollRange;
}

/**
 * Thumb span and offset along the scroll axis: horizontal → width + `left`, vertical → height + `top`.
 * Same rules as `AuthenticatedHomeLeftNavStrip` (proportional size, {@link SCROLL_INDICATOR_THUMB_MAX_TRACK_FRAC} cap,
 * min thumb floor, epsilon edge pins, then pixel snap).
 */
export function scrollIndicatorThumbSpanAndOffset(
  trackSpan: number,
  viewportSpan: number,
  contentSpan: number,
  scrollOffset: number,
  scrollRange: number,
  thumbMinPx: number = SCROLL_INDICATOR_THUMB_MIN_PX,
): { thumbSpan: number; thumbOffset: number } {
  if (trackSpan <= 0 || contentSpan <= 0 || scrollRange <= 0) {
    return { thumbSpan: 0, thumbOffset: 0 };
  }
  const minThumb = Math.max(1, thumbMinPx);
  const scrollClamped = Math.max(0, Math.min(scrollOffset, scrollRange));
  const ratio = Math.min(1, Math.max(0, viewportSpan / contentSpan));
  let thumbSpan = Math.round(trackSpan * ratio);
  const capSpan = Math.round(trackSpan * SCROLL_INDICATOR_THUMB_MAX_TRACK_FRAC);
  thumbSpan = Math.min(thumbSpan, capSpan);
  thumbSpan = Math.max(minThumb, Math.min(trackSpan - 1, thumbSpan));

  let thumbOffset = Math.round((scrollClamped / scrollRange) * Math.max(0, trackSpan - thumbSpan));
  if (scrollClamped <= SCROLL_INDICATOR_SCROLL_EPS) thumbOffset = 0;
  if (scrollClamped >= scrollRange - SCROLL_INDICATOR_SCROLL_EPS) {
    thumbOffset = trackSpan - thumbSpan;
  }
  thumbOffset = Math.max(0, Math.min(thumbOffset, trackSpan - thumbSpan));

  thumbSpan = snapScrollIndicatorCoordPx(thumbSpan);
  thumbOffset = snapScrollIndicatorCoordPx(thumbOffset);
  thumbOffset = Math.max(0, Math.min(thumbOffset, trackSpan - thumbSpan));

  return { thumbSpan, thumbOffset };
}

/**
 * Border width for the vertical scroll thumb: **one device pixel** in CSS px (`1 / dpr`), same idea as
 * menu hairlines elsewhere. Plain `1` is one **CSS** px and reads thicker than other app rules on retina.
 */
export function scrollIndicatorHairlineBorderWidthPx(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

/** One device-pixel border width for fields, pills, and scroll thumbs (alias of {@link scrollIndicatorHairlineBorderWidthPx}). */
export function hairlineBorderWidthPx(): number {
  return scrollIndicatorHairlineBorderWidthPx();
}

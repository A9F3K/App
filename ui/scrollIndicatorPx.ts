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

/**
 * Minimum overflow (px) before the custom thumb is shown.
 * ~1 CSS px swallows flex/subpixel phantoms; kept ≤2 so short real ranges still show.
 * Recompute from DPR so browser zoom does not flip visibility on the same layout.
 */
export function scrollIndicatorOverflowEpsilonPx(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  // One device pixel in CSS px, but never below 1 (phantom flex fill) or above 2.
  return Math.min(2, Math.max(1, 1 / dpr));
}

/** True when content is tall enough to warrant a vertical scroll thumb. */
export function scrollContentOverflowsViewport(contentH: number, viewH: number): boolean {
  if (!(viewH > 0) || !(contentH > 0)) return false;
  return contentH > viewH + scrollIndicatorOverflowEpsilonPx();
}

/**
 * Remaining height (px) inside {@link shellEl}'s flex slot after sibling chrome (headers, etc.).
 * Used when RN-web lets the shell grow with content (`overflow: visible`) so flex `minHeight: 0`
 * alone does not produce a real scrollport — common in the AI third column.
 *
 * Walks up flex ancestors when the immediate parent expanded with content height.
 * Floating dialogs mark `[data-hsp-floating-dialog-body]` so we never walk past the
 * header/scroll/footer column (that would return the full sheet height and hide the thumb).
 */
export function readShellFlexAvailableHeightPx(shellEl: HTMLElement | null | undefined): number {
  if (!shellEl) return 0;

  const dialogBody =
    shellEl.closest("[data-hsp-floating-dialog-body]") ??
    shellEl.closest(".hsp-floating-dialog-body");
  if (dialogBody instanceof HTMLElement) {
    const parentH = dialogBody.clientHeight;
    if (parentH > 0) {
      let siblingsH = 0;
      for (let i = 0; i < dialogBody.children.length; i += 1) {
        const child = dialogBody.children[i] as HTMLElement | null;
        if (!child) continue;
        if (child === shellEl || child.contains(shellEl)) continue;
        siblingsH += child.offsetHeight;
      }
      return Math.max(0, parentH - siblingsH);
    }
  }

  let node: HTMLElement | null = shellEl;
  for (let depth = 0; depth < 10 && node; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;
    const parentH = parent.clientHeight;
    if (!(parentH > 0)) {
      node = parent;
      continue;
    }

    let siblingsH = 0;
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i] as HTMLElement | null;
      if (!child || child === node) continue;
      siblingsH += child.offsetHeight;
    }
    const avail = Math.max(0, parentH - siblingsH);
    if (avail <= 0) {
      node = parent;
      continue;
    }

    const eps = scrollIndicatorOverflowEpsilonPx();
    const parentScrollOverflow = parent.scrollHeight - parentH;
    const parentGrewWithContent =
      parentScrollOverflow <= eps && parent.offsetHeight >= parentH - eps && siblingsH > 0;
    if (!parentGrewWithContent || depth >= 9) {
      return avail;
    }
    node = parent;
  }
  return 0;
}

/**
 * Live DOM overflow for a scrollport. Prefer this over React layout/content events —
 * under browser zoom those can disagree by a few CSS px and flicker the thumb.
 *
 * When {@link shellEl} is provided and the scroll node has grown to its content height
 * (clientHeight ≈ scrollHeight) while the shell / flex parent is shorter, use that capped
 * height so the thumb still appears for clipped overflow (common in the AI third column).
 */
export function readScrollportOverflowPx(
  el: HTMLElement | null | undefined,
  shellEl?: HTMLElement | null,
): {
  layoutH: number;
  contentH: number;
  overflowPx: number;
  overflows: boolean;
} | null {
  if (!el) return null;
  const dialogBody =
    el.closest("[data-hsp-floating-dialog-body]") ??
    el.closest(".hsp-floating-dialog-body") ??
    shellEl?.closest("[data-hsp-floating-dialog-body]") ??
    shellEl?.closest(".hsp-floating-dialog-body");
  const contentWrap = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null;
  // RN-web can report scrollHeight === clientHeight while the inner content is taller
  // and clipped by an ancestor — especially inside floating dialogs.
  let contentH = Math.max(
    el.scrollHeight,
    contentWrap?.scrollHeight ?? 0,
    contentWrap?.offsetHeight ?? 0,
  );
  let layoutH = el.clientHeight;
  const parentAvail = shellEl ? readShellFlexAvailableHeightPx(shellEl) : 0;
  const hostAvail = shellEl ? readSplitColumnScrollHostHeightPx(shellEl) : 0;
  const flexAvail = Math.max(parentAvail, hostAvail);
  const shellH = shellEl?.clientHeight ?? 0;
  // Prefer the flex allocation over a shell that has already grown to content height.
  const capH =
    flexAvail > 0 && shellH > 0
      ? Math.min(shellH, flexAvail)
      : flexAvail > 0
        ? flexAvail
        : shellH;
  if (!(layoutH > 0) && !(capH > 0)) return null;
  const eps = scrollIndicatorOverflowEpsilonPx();
  if (capH > 0) {
    const scrollGrewToContent = layoutH <= 0 || contentH <= layoutH + eps;
    if (scrollGrewToContent && contentH > capH + eps) {
      layoutH = capH;
    } else if (layoutH > 0 && capH + 0.5 < layoutH) {
      layoutH = capH;
    } else if (!(layoutH > 0)) {
      layoutH = capH;
    }
    // Dialogs: always prefer the flex slot when the scrollport has inflated to content.
    if (dialogBody instanceof HTMLElement && contentH > capH + eps) {
      layoutH = Math.min(layoutH > 0 ? layoutH : capH, capH);
    }
  }
  if (!(layoutH > 0)) return null;
  const overflowPx = Math.max(0, contentH - layoutH);
  return {
    layoutH,
    contentH,
    overflowPx,
    overflows: overflowPx > eps,
  };
}

/**
 * Portal `left` from the painted split-pane divider stroke nearest to this column’s right edge.
 * Falls back to geometry when no stroke node is mounted yet.
 */
export function measureNearestSplitDividerPortalLeftPx(columnRightPx: number): number | null {
  if (typeof document === "undefined") return null;
  const hairline = scrollIndicatorHairlineBorderWidthPx();
  const nodes = document.querySelectorAll<HTMLElement>("[data-hsp-split-divider-stroke]");
  let best: { dist: number; portalLeft: number } | null = null;
  for (let i = 0; i < nodes.length; i += 1) {
    const rect = nodes[i]!.getBoundingClientRect();
    // Width-0 + borderLeft: some engines report width 0, others include the border.
    const strokeRight = rect.width > 0.05 ? rect.left + rect.width : rect.left + hairline;
    const dist = Math.abs(strokeRight - columnRightPx);
    if (!best || dist < best.dist) {
      best = { dist, portalLeft: strokeRight };
    }
  }
  // Seam thumbs sit on the column’s right edge; ignore strokes more than ~½ hit strip away.
  if (!best || best.dist > 8) return null;
  return snapScrollIndicatorCoordPx(best.portalLeft);
}

/**
 * Portal `left` for a flush column-seam thumb so a right-anchored hairline lands on the
 * same device pixels as {@link AuthenticatedHomeSplitBody}'s divider stroke.
 *
 * Prefers a live measure of `[data-hsp-split-divider-stroke]`. If no stroke sits on this
 * column’s right edge (rightmost / viewport-flush column), stay on `columnRightPx` —
 * applying divider geometry there shifts the thumb left of the edge.
 */
export function scrollIndicatorSplitSeamPortalLeftPx(columnRightPx: number): number {
  const measured = measureNearestSplitDividerPortalLeftPx(columnRightPx);
  if (measured != null) return measured;
  return snapScrollIndicatorCoordPx(columnRightPx);
}

/** True when the scroll shell lives in a split column pinned to the viewport's right edge (no right divider). */
export function isSplitColumnFlushRight(shellEl: HTMLElement | null | undefined): boolean {
  if (!shellEl) return false;
  return shellEl.closest("[data-hsp-column-flush-right]") != null;
}

/**
 * Height (px) available to a scroll shell inside `[data-hsp-split-column-scroll-host]`,
 * subtracting fixed siblings (headers) between the shell and that host.
 */
export function readSplitColumnScrollHostHeightPx(shellEl: HTMLElement | null | undefined): number {
  if (!shellEl) return 0;
  const host = shellEl.closest("[data-hsp-split-column-scroll-host]") as HTMLElement | null;
  if (!host) return 0;
  const hostH = host.clientHeight;
  if (!(hostH > 0)) return 0;

  let chromeH = 0;
  let node: HTMLElement | null = shellEl;
  while (node && node !== host) {
    const parent = node.parentElement;
    if (!parent) break;
    for (let i = 0; i < parent.children.length; i += 1) {
      const sibling = parent.children[i];
      if (sibling !== node && sibling instanceof HTMLElement) {
        chromeH += sibling.offsetHeight;
      }
    }
    node = parent;
  }
  return Math.max(0, hostH - chromeH);
}

/** Portal `left` for a vertical thumb: viewport edge when flush-right / at edge, else split seam. */
export function scrollIndicatorPortalLeftPx(
  columnRightPx: number,
  shellEl?: HTMLElement | null,
): number {
  const viewportW =
    typeof window !== "undefined"
      ? snapScrollIndicatorCoordPx(window.visualViewport?.width ?? window.innerWidth)
      : null;
  if (viewportW != null) {
    if (isSplitColumnFlushRight(shellEl) || isScrollIndicatorAtViewportRightEdge(columnRightPx)) {
      return viewportW;
    }
  }
  return scrollIndicatorSplitSeamPortalLeftPx(columnRightPx);
}

/** Extra hit area (px) perpendicular to the scroll axis for dragging hairline thumbs. */
export const SCROLL_INDICATOR_DRAG_HIT_INSET_PX = 3;

/**
 * Right inset so the 1px scroll thumb sits on a 1px chrome border (floating dialogs, side menu).
 * Negative = overhang into the border; pair with `scrollIndicatorOverlaySeam={false}`.
 */
export const SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX = -1;

/**
 * Portaled thumb width (px) when flush with the viewport right edge on **light** theme.
 * Dark theme keeps the hairline; light hairlines clip against letterboxing / subpixels.
 */
export const SCROLL_INDICATOR_VIEWPORT_EDGE_THUMB_PX = 3;

/** True when a portaled vertical thumb anchor sits on the viewport's right edge. */
export function isScrollIndicatorAtViewportRightEdge(rightPx: number): boolean {
  if (typeof window === "undefined") return false;
  const viewportW = window.visualViewport?.width ?? window.innerWidth;
  if (!(viewportW > 0)) return false;
  // DPR 1.25 / zoom often leaves 1–2 CSS px of slack between shell right and visualViewport.
  return Math.abs(rightPx - viewportW) <= 2.5;
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

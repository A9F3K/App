/**
 * Bidirectional history window budget (tdesktop-style).
 * Prefer N messages above and N below the anchor; when a side hits the history
 * edge, shift the unused budget to the other side up to 2N total.
 */

/** N messages preferred on each side of the open / scroll anchor. */
export const CHAT_HISTORY_WINDOW_N = 40;

export type HistoryWindowBudget = {
  /** Rows strictly older than the anchor (before anchor index). */
  older: number;
  /** Rows strictly newer than the anchor (after anchor index). */
  newer: number;
};

/**
 * Allocate older/newer counts around `anchorIndex` in a list of `totalCount`.
 * Always targets up to 2N when the thread is long enough; shortfalls on one
 * side are added to the other (e.g. N−3 available older → N+3 newer).
 */
export function redistributeWindowBudget(
  totalCount: number,
  anchorIndex: number,
  nPerSide: number = CHAT_HISTORY_WINDOW_N,
): HistoryWindowBudget {
  if (totalCount <= 0 || nPerSide <= 0) {
    return { older: 0, newer: 0 };
  }
  const anchor = Math.max(0, Math.min(anchorIndex, totalCount - 1));
  const olderAvailable = anchor;
  const newerAvailable = Math.max(0, totalCount - 1 - anchor);
  const maxTotal = Math.min(nPerSide * 2, olderAvailable + newerAvailable);

  let older = Math.min(nPerSide, olderAvailable);
  let newer = Math.min(nPerSide, newerAvailable);

  const shortfallOlder = Math.max(0, nPerSide - older);
  const shortfallNewer = Math.max(0, nPerSide - newer);
  if (shortfallOlder > 0) {
    newer = Math.min(newerAvailable, newer + shortfallOlder);
  }
  if (shortfallNewer > 0) {
    older = Math.min(olderAvailable, older + shortfallNewer);
  }

  let total = older + newer;
  while (total > maxTotal && total > 0) {
    if (newer >= older && newer > 0) {
      newer -= 1;
    } else if (older > 0) {
      older -= 1;
    } else {
      break;
    }
    total = older + newer;
  }

  return { older, newer };
}

/** Inclusive start/end indices for a redistributed window around `anchorIndex`. */
export function windowBoundsAroundAnchor(
  totalCount: number,
  anchorIndex: number,
  nPerSide: number = CHAT_HISTORY_WINDOW_N,
): { startIndex: number; endIndex: number } {
  if (totalCount <= 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  const anchor = Math.max(0, Math.min(anchorIndex, totalCount - 1));
  const { older, newer } = redistributeWindowBudget(totalCount, anchor, nPerSide);
  return {
    startIndex: anchor - older,
    endIndex: anchor + newer,
  };
}

/**
 * Prefetch distance in px from an edge (tdesktop kPreloadHeightsCount = 3).
 * Falls back to a fixed floor when layout height is unknown.
 */
export function chatEdgePrefetchPx(
  layoutH: number,
  screens = 3,
  floorPx = 750,
): number {
  if (!(layoutH > 0) || !(screens > 0)) return floorPx;
  return Math.max(floorPx, Math.round(layoutH * screens));
}

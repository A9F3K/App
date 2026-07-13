import type { ChatScrollPhase } from "./chatScrollController";
import { canEdgeLoad } from "./chatScrollController";
import {
  MESSAGE_CHAT_LOAD_NEWER_THRESHOLD_PX,
  MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX,
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";

export type ChatEdgeLoadGateInput = {
  phase: ChatScrollPhase;
  userHasScrolledSinceOpen: boolean;
  initialScrollInProgress: boolean;
  prependAnchorRestorePending: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Directional: older requires scrolling up; newer requires scrolling down. */
  userScrollingUp: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  canExpandOlderInBuffer?: boolean;
  canHydrateOlderFromCache?: boolean;
  nearTop: boolean;
  /** scrollY within the hard top threshold — dwell at top counts as scroll-up intent. */
  atHardScrollTop?: boolean;
  /** scrollY within the hard bottom threshold — dwell at bottom counts as scroll-down intent. */
  atHardScrollBottom?: boolean;
  nearBottom: boolean;
  olderCooldownUntilMs?: number;
  newerRetryAfterMs?: number;
  nowMs?: number;
};

export type ChatEdgeLoadDecision = {
  loadOlder: boolean;
  loadNewer: boolean;
  reason: string;
};

/** Primary edge trigger distance (IntersectionObserver rootMargin uses MESSAGE_LIST_SENSITIVE_AREA_PX). */
export const CHAT_EDGE_SENSITIVE_AREA_PX = MESSAGE_LIST_SENSITIVE_AREA_PX;
export const CHAT_EDGE_OLDER_THRESHOLD_PX = MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX;
export const CHAT_EDGE_NEWER_THRESHOLD_PX = MESSAGE_CHAT_LOAD_NEWER_THRESHOLD_PX;

/**
 * Single gate for older/newer history loads (telegram-tt sensitive area).
 * Sentinels are the preferred trigger; near-top/bottom metrics are backups.
 */
export function decideChatEdgeLoad(input: ChatEdgeLoadGateInput): ChatEdgeLoadDecision {
  const now = input.nowMs ?? Date.now();

  if (input.initialScrollInProgress) {
    return { loadOlder: false, loadNewer: false, reason: "initial_scroll" };
  }
  if (!canEdgeLoad(input.phase)) {
    return { loadOlder: false, loadNewer: false, reason: `phase_${input.phase}` };
  }
  if (input.prependAnchorRestorePending) {
    return { loadOlder: false, loadNewer: false, reason: "prepend_restore" };
  }
  // Block mid-list until the user moves; older/newer edges are exempt (nearTop / nearBottom).
  if (
    !input.userHasScrolledSinceOpen &&
    !input.nearTop &&
    !input.nearBottom &&
    !input.atHardScrollBottom
  ) {
    return { loadOlder: false, loadNewer: false, reason: "await_user_scroll" };
  }

  const olderCooldown =
    input.olderCooldownUntilMs != null && now < input.olderCooldownUntilMs;
  const newerBackoff =
    input.newerRetryAfterMs != null && now < input.newerRetryAfterMs;

  const atHardScrollTop = input.atHardScrollTop === true;
  // Dwelling in the older prefetch band counts as scroll-up intent (tdesktop).
  const olderScrollIntent =
    input.userScrollingUp || atHardScrollTop || input.nearTop;
  const atHardScrollBottom = input.atHardScrollBottom === true;
  const newerScrollIntent = !input.userScrollingUp || atHardScrollBottom;

  const loadOlder =
    (input.hasMoreOlder ||
      input.canExpandOlderInBuffer === true ||
      input.canHydrateOlderFromCache === true) &&
    !input.loadingOlder &&
    !olderCooldown &&
    input.nearTop &&
    olderScrollIntent;

  const loadNewer =
    input.hasMoreNewer &&
    !input.loadingNewer &&
    !newerBackoff &&
    input.nearBottom &&
    newerScrollIntent &&
    (input.userHasScrolledSinceOpen || atHardScrollBottom);

  if (loadOlder) return { loadOlder: true, loadNewer: false, reason: "near_top" };
  if (loadNewer) return { loadOlder: false, loadNewer: true, reason: "near_bottom" };
  return { loadOlder: false, loadNewer: false, reason: "idle" };
}

/** Whether scrollY is within the older load threshold. */
export function isNearChatTop(scrollY: number, thresholdPx = CHAT_EDGE_OLDER_THRESHOLD_PX): boolean {
  return scrollY <= thresholdPx;
}

/** Whether scroll position is within the newer load threshold of the bottom. */
export function isNearChatBottom(
  scrollY: number,
  layoutH: number,
  contentH: number,
  thresholdPx = CHAT_EDGE_NEWER_THRESHOLD_PX,
): boolean {
  if (contentH <= layoutH + 0.5) return true;
  const maxScroll = Math.max(0, contentH - layoutH);
  return maxScroll - scrollY <= thresholdPx;
}

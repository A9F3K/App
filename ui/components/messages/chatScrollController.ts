import type { MutableRefObject } from "react";
import type {
  HspItemAnchor,
  HspScrollAnchor,
  HspScrollColumnHandle,
  HspScrollMetrics,
} from "../HspScrollColumn";

/** Single mutation phase — replaces overlapping boolean gates (telegram-tt isReplacingHistory). */
export type ChatScrollPhase =
  | "idle"
  | "open_settle"
  | "prepend"
  | "append"
  | "follow_bottom";

export type ChatScrollRemembered = {
  scrollTop: number;
  domAnchor: HspScrollAnchor | null;
  itemAnchor: HspItemAnchor | null;
};

export type ChatScrollControllerState = {
  phase: ChatScrollPhase;
  pinnedScrollY: number;
  pinnedLayoutH: number;
  remembered: ChatScrollRemembered | null;
  prependKind: "display_expand" | "api_load" | null;
};

export function createChatScrollControllerState(): ChatScrollControllerState {
  return {
    phase: "idle",
    pinnedScrollY: 0,
    pinnedLayoutH: 0,
    remembered: null,
    prependKind: null,
  };
}

export function isChatScrollMutating(phase: ChatScrollPhase): boolean {
  return phase !== "idle" && phase !== "follow_bottom";
}

/** True while history/display is being rewritten (skip IO edge loads). */
export function isReplacingHistory(phase: ChatScrollPhase): boolean {
  return phase === "prepend" || phase === "append" || phase === "open_settle";
}

export function isPrepending(phase: ChatScrollPhase): boolean {
  return phase === "prepend";
}

export function canEdgeLoad(phase: ChatScrollPhase): boolean {
  return phase === "idle" || phase === "follow_bottom";
}

/** Capture scrollTop + anchors once before a list merge (telegram-tt rememberScrollPosition). */
export function rememberBeforeUpdate(
  scroll: HspScrollColumnHandle | null,
  captureItemAnchor: () => HspItemAnchor | null,
): ChatScrollRemembered {
  const metrics = scroll?.getMetrics();
  const scrollTop = metrics?.scrollY ?? 0;
  return {
    scrollTop,
    domAnchor: scroll?.captureScrollAnchor() ?? null,
    itemAnchor: captureItemAnchor(),
  };
}

export function syncPinnedFromMetrics(
  state: ChatScrollControllerState,
  metrics: Pick<HspScrollMetrics, "scrollY" | "layoutH">,
): void {
  state.pinnedScrollY = metrics.scrollY;
  if (metrics.layoutH > 0) state.pinnedLayoutH = metrics.layoutH;
}

/**
 * Prefer item getBoundingClientRect keep on web; fall back to DOM height-delta.
 * Returns whether the viewport was successfully restored.
 */
export function restoreAfterUpdate(
  scroll: HspScrollColumnHandle | null,
  remembered: ChatScrollRemembered | null,
  options?: { preferDomDelta?: boolean },
): boolean {
  if (!scroll || !remembered) return false;
  const preferDom = options?.preferDomDelta === true;

  const tryItem = (): boolean => {
    const anchor = remembered.itemAnchor;
    if (!anchor || anchor.messageId <= 0) return false;
    return scroll.restoreItemAnchor(anchor);
  };

  const tryDom = (): boolean => {
    const dom = remembered.domAnchor;
    if (!dom) return false;
    return scroll.keepScrollPositionOnPrepend(dom);
  };

  if (preferDom) {
    if (tryDom()) return true;
    return tryItem();
  }
  if (tryItem()) return true;
  return tryDom();
}

/** Begin a prepend mutation; remember scroll before content changes. */
export function beginPrependPhase(
  state: ChatScrollControllerState,
  scroll: HspScrollColumnHandle | null,
  captureItemAnchor: () => HspItemAnchor | null,
  kind: "display_expand" | "api_load",
): ChatScrollRemembered {
  state.phase = "prepend";
  state.prependKind = kind;
  const remembered = rememberBeforeUpdate(scroll, captureItemAnchor);
  state.remembered = remembered;
  return remembered;
}

export function endPrependPhase(
  state: ChatScrollControllerState,
  scroll: HspScrollColumnHandle | null,
): void {
  const metrics = scroll?.getMetrics();
  if (metrics) syncPinnedFromMetrics(state, metrics);
  state.phase = "idle";
  state.prependKind = null;
  state.remembered = null;
}

export function beginOpenSettlePhase(state: ChatScrollControllerState): void {
  state.phase = "open_settle";
}

export function endOpenSettlePhase(
  state: ChatScrollControllerState,
  scroll: HspScrollColumnHandle | null,
): void {
  const metrics = scroll?.getMetrics();
  if (metrics) syncPinnedFromMetrics(state, metrics);
  state.phase = "idle";
}

export function beginFollowBottomPhase(state: ChatScrollControllerState): void {
  state.phase = "follow_bottom";
}

export function beginAppendPhase(state: ChatScrollControllerState): void {
  state.phase = "append";
}

export function endMutationPhase(
  state: ChatScrollControllerState,
  scroll: HspScrollColumnHandle | null,
  next: ChatScrollPhase = "idle",
): void {
  const metrics = scroll?.getMetrics();
  if (metrics) syncPinnedFromMetrics(state, metrics);
  state.phase = next;
  if (next !== "prepend") {
    state.prependKind = null;
    state.remembered = null;
  }
}

/**
 * Mirror phase into legacy boolean refs still read by list effects.
 * Prefer isReplacingHistory / isPrepending / canEdgeLoad in new code.
 */
export function applyPhaseToLegacyRefs(
  phase: ChatScrollPhase,
  refs: {
    isReplacingHistoryRef: MutableRefObject<boolean>;
    olderPrependInProgressRef: MutableRefObject<boolean>;
    prependKindRef: MutableRefObject<"display_expand" | "api_load" | null>;
  },
  prependKind: "display_expand" | "api_load" | null,
): void {
  refs.isReplacingHistoryRef.current = isReplacingHistory(phase);
  refs.olderPrependInProgressRef.current = isPrepending(phase);
  refs.prependKindRef.current = isPrepending(phase) ? prependKind : null;
}

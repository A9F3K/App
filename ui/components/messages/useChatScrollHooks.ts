/**
 * telegram-tt useScrollHooks analogue: edge history triggers + FAB readiness.
 * Sentinels (MessageHistoryLoadSentinel) are the primary trigger; callers pass
 * near-top / near-bottom as backup when IO is unavailable.
 */
import { useCallback, useRef } from "react";
import {
  decideChatEdgeLoad,
  isNearChatBottom,
  isNearChatTop,
  CHAT_EDGE_NEWER_THRESHOLD_PX,
  CHAT_EDGE_OLDER_THRESHOLD_PX,
  CHAT_EDGE_SENSITIVE_AREA_PX,
} from "./chatEdgeLoadPolicy";
import { MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX } from "./messageChatLayout";
import { chatEdgePrefetchPx } from "./chatHistoryWindowBudget";
import {
  canEdgeLoad,
  isReplacingHistory,
  type ChatScrollControllerState,
  type ChatScrollPhase,
} from "./chatScrollController";
import type { HspScrollMetrics } from "../HspScrollColumn";

export type ChatScrollHooksGate = {
  phase: ChatScrollPhase;
  userHasScrolledSinceOpen: boolean;
  initialScrollInProgress: boolean;
  prependAnchorRestorePending: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  userScrollingUp: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  canExpandOlderInBuffer?: boolean;
  canHydrateOlderFromCache?: boolean;
  olderCooldownUntilMs: number;
  newerRetryAfterMs: number;
};

export type ChatScrollHooksActions = {
  /** Expand in-buffer display toward older, or API-load when at loaded head. */
  onLoadOlder: () => void;
  /** Expand in-buffer display toward newer, or API-load when at loaded tail. */
  onLoadNewer: () => void;
};

/** Prefetch older pages before the hard top edge (tdesktop: 3 screens). */
function nearTopPrefetchPx(layoutH: number): number {
  return chatEdgePrefetchPx(layoutH, 3, MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX);
}

function nearBottomPrefetchPx(layoutH: number): number {
  return chatEdgePrefetchPx(
    layoutH,
    3,
    CHAT_EDGE_NEWER_THRESHOLD_PX + CHAT_EDGE_SENSITIVE_AREA_PX,
  );
}

export function useChatScrollHooks(options: {
  getPhase: () => ChatScrollPhase;
  getGate: () => ChatScrollHooksGate;
  getMetrics: () => HspScrollMetrics | null | undefined;
  actions: ChatScrollHooksActions;
  /** When false, IO/sentinel triggers are ignored (open settle / initial load). */
  historyIoEnabled: boolean;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const tryLoadOlder = useCallback(() => {
    const opts = optionsRef.current;
    if (!opts.historyIoEnabled) return;
    const gate = opts.getGate();
    const phase = opts.getPhase();
    if (isReplacingHistory(phase) && !canEdgeLoad(phase)) return;

    const metrics = opts.getMetrics();
    const nearTop =
      metrics == null ||
      metrics.layoutH <= 0 ||
      isNearChatTop(metrics.scrollY, nearTopPrefetchPx(metrics.layoutH));
    const atHardScrollTop =
      metrics != null &&
      metrics.layoutH > 0 &&
      isNearChatTop(metrics.scrollY, CHAT_EDGE_OLDER_THRESHOLD_PX);

    const decision = decideChatEdgeLoad({
      phase,
      userHasScrolledSinceOpen: gate.userHasScrolledSinceOpen,
      initialScrollInProgress: gate.initialScrollInProgress,
      prependAnchorRestorePending: gate.prependAnchorRestorePending,
      loadingOlder: gate.loadingOlder,
      loadingNewer: gate.loadingNewer,
      userScrollingUp: gate.userScrollingUp,
      hasMoreOlder: gate.hasMoreOlder,
      canExpandOlderInBuffer: gate.canExpandOlderInBuffer,
      canHydrateOlderFromCache: gate.canHydrateOlderFromCache,
      hasMoreNewer: false,
      nearTop,
      atHardScrollTop,
      nearBottom: false,
      olderCooldownUntilMs: gate.olderCooldownUntilMs,
    });
    if (!decision.loadOlder) return;
    opts.actions.onLoadOlder();
  }, []);

  const tryLoadNewer = useCallback(() => {
    const opts = optionsRef.current;
    if (!opts.historyIoEnabled) return;
    const gate = opts.getGate();
    const phase = opts.getPhase();
    if (isReplacingHistory(phase) && !canEdgeLoad(phase)) return;

    const metrics = opts.getMetrics();
    const nearBottom =
      metrics != null &&
      metrics.layoutH > 0 &&
      isNearChatBottom(
        metrics.scrollY,
        metrics.layoutH,
        metrics.contentH,
        nearBottomPrefetchPx(metrics.layoutH),
      );
    const atHardScrollBottom =
      metrics != null &&
      metrics.layoutH > 0 &&
      isNearChatBottom(
        metrics.scrollY,
        metrics.layoutH,
        metrics.contentH,
        CHAT_EDGE_NEWER_THRESHOLD_PX + CHAT_EDGE_SENSITIVE_AREA_PX,
      );

    const decision = decideChatEdgeLoad({
      phase,
      userHasScrolledSinceOpen: gate.userHasScrolledSinceOpen,
      initialScrollInProgress: gate.initialScrollInProgress,
      prependAnchorRestorePending: gate.prependAnchorRestorePending,
      loadingOlder: gate.loadingOlder,
      loadingNewer: gate.loadingNewer,
      userScrollingUp: gate.userScrollingUp,
      hasMoreOlder: false,
      hasMoreNewer: gate.hasMoreNewer,
      nearTop: false,
      nearBottom,
      atHardScrollBottom,
      newerRetryAfterMs: gate.newerRetryAfterMs,
    });
    if (!decision.loadNewer) return;
    opts.actions.onLoadNewer();
  }, []);

  /** telegram-tt FAB_THRESHOLD / NOTCH_THRESHOLD readiness helper. */
  const isFabVisible = useCallback(
    (args: {
      metrics: Pick<HspScrollMetrics, "scrollY" | "layoutH" | "contentH">;
      isUnread: boolean;
      followingBottom: boolean;
      fabThresholdPx: number;
      notchThresholdPx: number;
    }): boolean => {
      const { metrics, isUnread, followingBottom, fabThresholdPx, notchThresholdPx } =
        args;
      if (metrics.contentH <= 0 || metrics.layoutH <= 0) return false;
      if (!followingBottom) return true;
      const maxScroll = Math.max(0, metrics.contentH - metrics.layoutH);
      const distanceFromBottom = maxScroll - metrics.scrollY;
      if (isUnread) return distanceFromBottom > notchThresholdPx;
      return distanceFromBottom > fabThresholdPx;
    },
    [],
  );

  return {
    tryLoadOlder,
    tryLoadNewer,
    isFabVisible,
  };
}

/** Snapshot gate fields from live refs/state (call inside getGate). */
export function readChatScrollHooksGateFromController(
  state: ChatScrollControllerState,
  fields: Omit<ChatScrollHooksGate, "phase">,
): ChatScrollHooksGate {
  return { phase: state.phase, ...fields };
}

import {
  fetchJettonChartSeries,
  isMainChartFetchActive,
  setOnMainChartFetchIdle,
} from "./fetchSwapChart";
import { peekSwapChartSeriesCache } from "./swapChartSeriesCache";
import { isVoiceDialogUiOpen } from "../components/messages/voiceDialogUiGate";

export type ChooseCurrencyYearChartSnapshot =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; normalized: number[] }
  | { status: "empty" };

/** Stable referents for useSyncExternalStore — never return fresh `{}` from getSnapshot. */
const IDLE_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "idle" };
const LOADING_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "loading" };
const EMPTY_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "empty" };

/**
 * Visible-row sparklines used to look lazy because the pump started one
 * request, then waited 1.1s (and the shared DYOR limiter waited another 1s).
 * A small parallel pool fills the on-screen column quickly; 429s back off.
 */
const MAX_CONCURRENT = 2;
const REQUEST_GAP_MS = 120;
const RATE_LIMIT_GAP_MS = 1500;
const RETRY_BASE_DELAY_MS = 4000;
const RETRY_MAX_DELAY_MS = 24000;
/**
 * FlatList windowSize≈9 mounts far more than 40 sparklines. A tiny queue dropped
 * pending addresses permanently (mounted cells never re-called ensure).
 */
const MAX_QUEUED = 240;
/** Re-try hard empties after this cooldown (e.g. brief API gaps). */
const EMPTY_RETRY_COOLDOWN_MS = 60_000;
/** Downsample for 40px-tall sparklines. */
const MINI_CHART_MAX_POINTS = 48;

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

const cache = new Map<string, ChooseCurrencyYearChartSnapshot>();
const emptyAtMs = new Map<string, number>();
const attemptCount = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
/** Scroll-window rows from ChooseCurrencyTable — highest fetch priority. */
const visibleWindow = new Set<string>();
/** IntersectionObserver near-view rows (refcounted per address). */
const nearViewRefcount = new Map<string, number>();
const queued: string[] = [];
const queuedSet = new Set<string>();
let activeCount = 0;
let lastStartMs = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let rateLimitedUntilMs = 0;
let consecutiveRateLimits = 0;

function notify(address: string): void {
  const set = listeners.get(address);
  if (!set) return;
  for (const listener of set) listener();
}

function setSnapshot(address: string, snap: ChooseCurrencyYearChartSnapshot): void {
  const prev = cache.get(address);
  if (prev === snap) return;
  if (
    prev &&
    snap.status === "ready" &&
    prev.status === "ready" &&
    prev.normalized === snap.normalized
  ) {
    return;
  }
  cache.set(address, snap);
  if (snap.status === "empty") emptyAtMs.set(address, Date.now());
  if (snap.status === "ready") emptyAtMs.delete(address);
  notify(address);
}

function downsample(points: number[]): number[] {
  if (points.length <= MINI_CHART_MAX_POINTS || MINI_CHART_MAX_POINTS < 2) return points;
  const out: number[] = [];
  const last = points.length - 1;
  for (let i = 0; i < MINI_CHART_MAX_POINTS; i++) {
    const idx = Math.round((i / (MINI_CHART_MAX_POINTS - 1)) * last);
    out.push(points[idx]!);
  }
  return out;
}

function trySeedFromSeriesCache(address: string): boolean {
  const peek = peekSwapChartSeriesCache(address, "day1");
  if (!peek || peek.normalized.length === 0) return false;
  setSnapshot(address, {
    status: "ready",
    normalized: downsample(peek.normalized),
  });
  return true;
}

function scheduleRetry(address: string, attempt: number): void {
  const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 3));
  setTimeout(() => {
    const current = cache.get(address);
    // Only retry if still waiting (not ready/empty from another path).
    if (current && current.status !== "loading" && current.status !== "idle") return;
    cache.delete(address);
    queuedSet.delete(address);
    ensureChooseCurrencyYearChart(address);
  }, delay);
}

async function runFetch(address: string): Promise<void> {
  if (isVoiceDialogUiOpen()) {
    // Defer mid-dialog — parsing chart JSON on the main thread freezes Close.
    enqueueFront(address);
    return;
  }
  if (trySeedFromSeriesCache(address)) return;

  setSnapshot(address, LOADING_SNAPSHOT);
  const result = await fetchJettonChartSeries(address, "day1", {
    respectGlobalRateLimit: true,
  });

  if (isVoiceDialogUiOpen()) {
    // Dialog opened while the fetch was in flight — don't parse/apply yet.
    enqueueFront(address);
    cache.delete(address);
    return;
  }

  if (result.ok) {
    consecutiveRateLimits = 0;
    attemptCount.delete(address);
    setSnapshot(address, {
      status: "ready",
      normalized: downsample(result.series.normalized),
    });
    return;
  }

  if (result.retryable) {
    if (result.error.toLowerCase().includes("rate limit")) {
      consecutiveRateLimits += 1;
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_GAP_MS * consecutiveRateLimits;
    }
    // Never give up on 429 / network — keep loading and back off.
    const attempts = (attemptCount.get(address) ?? 0) + 1;
    attemptCount.set(address, attempts);
    scheduleRetry(address, attempts);
    return;
  }

  attemptCount.delete(address);
  setSnapshot(address, EMPTY_SNAPSHOT);
}

function currentMaxConcurrent(): number {
  return consecutiveRateLimits > 0 ? 1 : MAX_CONCURRENT;
}

function currentRequestGapMs(): number {
  return consecutiveRateLimits > 0 ? RATE_LIMIT_GAP_MS : REQUEST_GAP_MS;
}

function pumpQueue(): void {
  if (pumpTimer != null) return;

  const tick = () => {
    pumpTimer = null;
    rebalanceQueue();
    // Year sparklines parse 200–300 points each and freeze the voice dialog
    // (logs: swap_chart_parse_done overlapping voice_dialog_longtask / raf_stall).
    if (isVoiceDialogUiOpen()) {
      pumpTimer = setTimeout(tick, 2_500);
      return;
    }
    if (isMainChartFetchActive()) {
      pumpTimer = setTimeout(tick, 150);
      return;
    }

    while (activeCount < currentMaxConcurrent() && queued.length > 0) {
      const now = Date.now();
      const rateWait = Math.max(0, rateLimitedUntilMs - now);
      const gapWait = Math.max(0, currentRequestGapMs() - (now - lastStartMs));
      const wait = Math.max(rateWait, gapWait);
      if (wait > 0) {
        pumpTimer = setTimeout(tick, wait);
        return;
      }

      const address = queued.shift();
      if (!address) return;
      queuedSet.delete(address);

      const existing = cache.get(address);
      if (
        existing &&
        (existing.status === "ready" || existing.status === "empty" || existing.status === "loading")
      ) {
        continue;
      }

      activeCount += 1;
      lastStartMs = Date.now();
      void runFetch(address).finally(() => {
        activeCount -= 1;
        pumpQueue();
      });
    }
  };

  tick();
}

/** Drop pending sparkline work when the voice sheet opens. */
export function clearQueuedChooseCurrencyYearCharts(): void {
  queued.length = 0;
  queuedSet.clear();
}

/** Scroll-visible window from ChooseCurrencyTable — on-screen rows win the queue. */
export function syncChooseCurrencyYearChartVisibleWindow(addresses: readonly string[]): void {
  visibleWindow.clear();
  for (const address of addresses) {
    const key = normalizeAddress(address);
    if (key && !key.startsWith("jetton:")) visibleWindow.add(key);
  }
  rebalanceQueue();
  pumpQueue();
}

export function clearChooseCurrencyYearChartVisibleWindow(): void {
  if (visibleWindow.size === 0) return;
  visibleWindow.clear();
  rebalanceQueue();
}

export function registerChooseCurrencyYearChartNearView(address: string): void {
  const key = normalizeAddress(address);
  if (!key) return;
  nearViewRefcount.set(key, (nearViewRefcount.get(key) ?? 0) + 1);
  if (queuedSet.has(key)) promoteInQueue(key);
  rebalanceQueue();
  pumpQueue();
}

export function unregisterChooseCurrencyYearChartNearView(address: string): void {
  const key = normalizeAddress(address);
  if (!key) return;
  const next = (nearViewRefcount.get(key) ?? 0) - 1;
  if (next <= 0) nearViewRefcount.delete(key);
  else nearViewRefcount.set(key, next);
  if (next <= 0 && queuedSet.has(key)) demoteInQueue(key);
  rebalanceQueue();
}

setOnMainChartFetchIdle(() => {
  pumpQueue();
});

export function getChooseCurrencyYearChartSnapshot(address: string): ChooseCurrencyYearChartSnapshot {
  return cache.get(normalizeAddress(address)) ?? IDLE_SNAPSHOT;
}

export function subscribeChooseCurrencyYearChart(
  address: string,
  onStoreChange: () => void,
): () => void {
  const key = normalizeAddress(address);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(onStoreChange);
  return () => {
    set!.delete(onStoreChange);
    if (set!.size === 0) listeners.delete(key);
  };
}

function isPriorityAddress(address: string): boolean {
  return visibleWindow.has(address) || (nearViewRefcount.get(address) ?? 0) > 0;
}

function rebalanceQueue(): void {
  if (queued.length < 2) return;
  const priority: string[] = [];
  const background: string[] = [];
  for (const addr of queued) {
    if (isPriorityAddress(addr)) priority.push(addr);
    else background.push(addr);
  }
  if (priority.length === 0 || background.length === 0) return;
  queued.length = 0;
  queued.push(...priority, ...background);
}

function demoteInQueue(address: string): void {
  const idx = queued.indexOf(address);
  if (idx < 0) return;
  queued.splice(idx, 1);
  queued.push(address);
}

function promoteInQueue(address: string): void {
  const idx = queued.indexOf(address);
  if (idx <= 0) return;
  queued.splice(idx, 1);
  queued.unshift(address);
}

function enqueueFront(address: string): void {
  // Prefer visible (newly ensured) rows over older off-screen backlog.
  while (queued.length >= MAX_QUEUED) {
    let dropIdx = -1;
    for (let i = queued.length - 1; i >= 0; i--) {
      const candidate = queued[i]!;
      if (!isPriorityAddress(candidate)) {
        dropIdx = i;
        break;
      }
    }
    if (dropIdx < 0) break; // all pending are still on-screen — allow overflow
    const dropped = queued.splice(dropIdx, 1)[0];
    if (dropped) queuedSet.delete(dropped);
  }

  if (queuedSet.has(address)) {
    if (isPriorityAddress(address)) promoteInQueue(address);
    else demoteInQueue(address);
    return;
  }
  queuedSet.add(address);
  if (isPriorityAddress(address)) queued.unshift(address);
  else queued.push(address);
}

/** Ensure a year sparkline is loading / cached for this jetton address. */
export function ensureChooseCurrencyYearChart(address: string): void {
  const key = normalizeAddress(address);
  if (!key || key.startsWith("jetton:")) return;

  if (trySeedFromSeriesCache(key)) return;

  const existing = cache.get(key);
  if (existing?.status === "ready" || existing?.status === "loading") return;
  if (existing?.status === "empty") {
    const emptiedAt = emptyAtMs.get(key) ?? 0;
    if (Date.now() - emptiedAt < EMPTY_RETRY_COOLDOWN_MS) return;
    cache.delete(key);
    emptyAtMs.delete(key);
  }

  enqueueFront(key);
  pumpQueue();
}

/** Queue on-screen (and nearby) rows so the first visible plot is fetched first. */
export function prefetchChooseCurrencyYearCharts(addresses: readonly string[]): void {
  for (let i = addresses.length - 1; i >= 0; i--) {
    const address = addresses[i];
    if (address) ensureChooseCurrencyYearChart(address);
  }
}

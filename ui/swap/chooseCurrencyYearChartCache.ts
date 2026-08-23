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
 * Viewport-first DYOR sparkline pump.
 *
 * Blast-all 429s and fills out of order. Strict 1-by-1 with a 4s 429 skip
 * leaves the first rows last. Balance: two in-flight, short start spacing,
 * visible/lookahead before the rest, and a 429 retries that same row next.
 */
const MAX_CONCURRENT_HEALTHY = 2;
const START_GAP_HEALTHY_MS = 90;
const START_GAP_COOLDOWN_MS = 650;
const RATE_LIMIT_BACKOFF_MS = 700;
const RATE_LIMIT_BACKOFF_CAP_MS = 2400;
/** Rows below the visible window that still outrank the rest of the catalog. */
const LOOKAHEAD_ROWS = 24;
const MAX_QUEUED = 240;
const EMPTY_RETRY_COOLDOWN_MS = 60_000;
const MINI_CHART_MAX_POINTS = 48;

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

const cache = new Map<string, ChooseCurrencyYearChartSnapshot>();
const emptyAtMs = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
/** Scroll-window rows from ChooseCurrencyTable — highest fetch priority. */
const visibleWindow = new Set<string>();
/** Top-to-bottom sparkline order of the current currency table. */
const listOrder = new Map<string, number>();
const queued: string[] = [];
const queuedSet = new Set<string>();
const inFlight = new Set<string>();
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

function visibleExtent(): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = -1;
  for (const address of visibleWindow) {
    const index = listOrder.get(address);
    if (index == null) continue;
    if (index < min) min = index;
    if (index > max) max = index;
  }
  if (max < 0) {
    return { min: 0, max: Math.max(0, LOOKAHEAD_ROWS - 1) };
  }
  return { min, max };
}

function priorityBand(address: string): 0 | 1 | 2 {
  const index = listOrder.get(address);
  if (index == null) return 2;
  const { min, max } = visibleExtent();
  if (index >= min && index <= max) return 0;
  if (index <= max + LOOKAHEAD_ROWS) return 1;
  return 2;
}

function compareQueueOrder(a: string, b: string): number {
  const bandDelta = priorityBand(a) - priorityBand(b);
  if (bandDelta !== 0) return bandDelta;
  return (listOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (listOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
}

function rebalanceQueue(): void {
  if (queued.length < 2) return;
  queued.sort(compareQueueOrder);
}

function currentMaxConcurrent(): number {
  return consecutiveRateLimits > 0 ? 1 : MAX_CONCURRENT_HEALTHY;
}

function currentStartGapMs(): number {
  return consecutiveRateLimits > 0 ? START_GAP_COOLDOWN_MS : START_GAP_HEALTHY_MS;
}

function noteRateLimit(): void {
  consecutiveSuccesses = 0;
  consecutiveRateLimits += 1;
  const wait = Math.min(
    RATE_LIMIT_BACKOFF_CAP_MS,
    RATE_LIMIT_BACKOFF_MS * consecutiveRateLimits,
  );
  rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + wait);
}

function noteSuccess(): void {
  consecutiveRateLimits = 0;
}

function enqueue(address: string): void {
  while (queued.length >= MAX_QUEUED) {
    let dropIdx = -1;
    let dropBand = -1;
    let dropOrder = -1;
    for (let i = 0; i < queued.length; i++) {
      const candidate = queued[i]!;
      const band = priorityBand(candidate);
      if (band === 0) continue;
      const order = listOrder.get(candidate) ?? Number.MAX_SAFE_INTEGER;
      if (band > dropBand || (band === dropBand && order >= dropOrder)) {
        dropIdx = i;
        dropBand = band;
        dropOrder = order;
      }
    }
    if (dropIdx < 0) break;
    const dropped = queued.splice(dropIdx, 1)[0];
    if (dropped) queuedSet.delete(dropped);
  }

  if (queuedSet.has(address)) {
    rebalanceQueue();
    return;
  }
  queuedSet.add(address);
  queued.push(address);
  rebalanceQueue();
}

async function runFetch(address: string): Promise<void> {
  if (isVoiceDialogUiOpen()) {
    enqueue(address);
    return;
  }
  if (trySeedFromSeriesCache(address)) return;

  setSnapshot(address, LOADING_SNAPSHOT);
  const result = await fetchJettonChartSeries(address, "day1", {
    respectGlobalRateLimit: false,
  });

  if (isVoiceDialogUiOpen()) {
    enqueue(address);
    cache.delete(address);
    return;
  }

  if (result.ok) {
    noteSuccess();
    setSnapshot(address, {
      status: "ready",
      normalized: downsample(result.series.normalized),
    });
    return;
  }

  if (result.retryable) {
    if (result.error.toLowerCase().includes("rate limit")) {
      noteRateLimit();
    }
    enqueue(address);
    return;
  }

  setSnapshot(address, EMPTY_SNAPSHOT);
}

function pumpQueue(): void {
  if (pumpTimer != null) return;

  const tick = () => {
    pumpTimer = null;
    rebalanceQueue();
    if (isVoiceDialogUiOpen()) {
      pumpTimer = setTimeout(tick, 2_500);
      return;
    }
    if (isMainChartFetchActive()) {
      pumpTimer = setTimeout(tick, 120);
      return;
    }

    while (inFlight.size < currentMaxConcurrent() && queued.length > 0) {
      const now = Date.now();
      const wait = Math.max(
        0,
        rateLimitedUntilMs - now,
        currentStartGapMs() - (now - lastStartMs),
      );
      if (wait > 0) {
        pumpTimer = setTimeout(tick, wait);
        return;
      }

      const address = queued.shift();
      if (!address) return;
      queuedSet.delete(address);

      if (inFlight.has(address)) continue;
      const existing = cache.get(address);
      if (existing?.status === "ready" || existing?.status === "empty") continue;

      inFlight.add(address);
      lastStartMs = Date.now();
      void runFetch(address).finally(() => {
        inFlight.delete(address);
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

/** Full table sparkline order (top → bottom). Queue drain follows this after visible rows. */
export function syncChooseCurrencyYearChartListOrder(addresses: readonly string[]): void {
  listOrder.clear();
  let index = 0;
  for (const address of addresses) {
    const key = normalizeAddress(address);
    if (!key || key.startsWith("jetton:")) continue;
    if (listOrder.has(key)) continue;
    listOrder.set(key, index);
    index += 1;
  }
  rebalanceQueue();
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

/** Kept so older callers compile; fetch priority is scroll + list order, not IO. */
export function registerChooseCurrencyYearChartNearView(_address: string): void {}

export function unregisterChooseCurrencyYearChartNearView(_address: string): void {}

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

/** Ensure a year sparkline is loading / cached for this jetton address. */
export function ensureChooseCurrencyYearChart(address: string): void {
  const key = normalizeAddress(address);
  if (!key || key.startsWith("jetton:")) return;

  if (trySeedFromSeriesCache(key)) return;
  if (inFlight.has(key)) return;

  const existing = cache.get(key);
  if (existing?.status === "ready") return;
  if (existing?.status === "empty") {
    const emptiedAt = emptyAtMs.get(key) ?? 0;
    if (Date.now() - emptiedAt < EMPTY_RETRY_COOLDOWN_MS) return;
    cache.delete(key);
    emptyAtMs.delete(key);
  }

  enqueue(key);
  pumpQueue();
}

/** Queue sparkline addresses in the given order (top → bottom of the table). */
export function prefetchChooseCurrencyYearCharts(addresses: readonly string[]): void {
  for (const address of addresses) {
    if (address) ensureChooseCurrencyYearChart(address);
  }
}

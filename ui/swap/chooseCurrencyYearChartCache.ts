import { CHART_RATE_LIMIT_MS, TON_JETTON_ADDRESS } from "./swapChartConstants";
import { fetchJettonChartSeries } from "./fetchSwapChart";
import { peekSwapChartSeriesCache } from "./swapChartSeriesCache";

export type ChooseCurrencyYearChartSnapshot =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; normalized: number[] }
  | { status: "empty" };

/** Stable referents for useSyncExternalStore — never return fresh `{}` from getSnapshot. */
const IDLE_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "idle" };
const LOADING_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "loading" };
const EMPTY_SNAPSHOT: ChooseCurrencyYearChartSnapshot = { status: "empty" };

/** One at a time — DYOR rate-limits aggressively (429) under parallel chart traffic. */
const MAX_CONCURRENT = 1;
const REQUEST_GAP_MS = Math.max(CHART_RATE_LIMIT_MS + 400, 1500);
const RETRY_BASE_DELAY_MS = 4000;
const RETRY_MAX_DELAY_MS = 24000;
/** Soft cap — drop oldest pending if list remount storms. */
const MAX_QUEUED = 40;
/** Re-try hard empties after this cooldown (e.g. brief API gaps). */
const EMPTY_RETRY_COOLDOWN_MS = 60_000;
/** Downsample for 40px-tall sparklines. */
const MINI_CHART_MAX_POINTS = 48;

const TON_ADDRESS = TON_JETTON_ADDRESS.trim().toLowerCase();

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

const cache = new Map<string, ChooseCurrencyYearChartSnapshot>();
const emptyAtMs = new Map<string, number>();
const attemptCount = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const queued: string[] = [];
const queuedSet = new Set<string>();
let activeCount = 0;
let lastStartMs = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

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

function trySeedFromTonMainChart(address: string): boolean {
  if (address !== TON_ADDRESS) return false;
  const peek = peekSwapChartSeriesCache("day1");
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
  if (trySeedFromTonMainChart(address)) return;

  setSnapshot(address, LOADING_SNAPSHOT);
  const result = await fetchJettonChartSeries(address, "day1", {
    // Share the global chart limiter with the main swap chart.
    respectGlobalRateLimit: true,
  });

  if (result.ok) {
    attemptCount.delete(address);
    setSnapshot(address, {
      status: "ready",
      normalized: downsample(result.series.normalized),
    });
    return;
  }

  if (result.retryable) {
    // Never give up on 429 / network — keep loading and back off.
    const attempts = (attemptCount.get(address) ?? 0) + 1;
    attemptCount.set(address, attempts);
    scheduleRetry(address, attempts);
    return;
  }

  attemptCount.delete(address);
  setSnapshot(address, EMPTY_SNAPSHOT);
}

function pumpQueue(): void {
  if (pumpTimer != null) return;

  const tick = () => {
    pumpTimer = null;
    if (activeCount >= MAX_CONCURRENT || queued.length === 0) return;

    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastStartMs));
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
      pumpQueue();
      return;
    }

    activeCount += 1;
    lastStartMs = Date.now();
    void runFetch(address).finally(() => {
      activeCount -= 1;
      pumpQueue();
    });
  };

  tick();
}

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

  if (trySeedFromTonMainChart(key)) return;

  const existing = cache.get(key);
  if (existing?.status === "ready" || existing?.status === "loading") return;
  if (existing?.status === "empty") {
    const emptiedAt = emptyAtMs.get(key) ?? 0;
    if (Date.now() - emptiedAt < EMPTY_RETRY_COOLDOWN_MS) return;
    cache.delete(key);
    emptyAtMs.delete(key);
  }
  if (queuedSet.has(key)) return;

  while (queued.length >= MAX_QUEUED) {
    const dropped = queued.shift();
    if (dropped) queuedSet.delete(dropped);
  }

  queuedSet.add(key);
  queued.push(key);
  pumpQueue();
}

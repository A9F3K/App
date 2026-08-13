import { logPageDisplay } from "../pageDisplayLog";
import { fetchSwapJettonsPage } from "./fetchSwapJettons";
import type { SwapJetton } from "./swapJettonsTypes";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const PAGE_FETCH_DELAY_MS = 180;
const UI_FLUSH_INTERVAL_MS = 350;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CatalogSnapshot = {
  jettons: readonly SwapJetton[];
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadedPages: number;
};

type Listener = () => void;

let jettons: SwapJetton[] = [];
let seenAddresses = new Set<string>();
let nextPage = 1;
let hasMore = true;
let isLoading = false;
let isFetchingMore = false;
let error: string | null = null;
let lastFetchTime = 0;
let loadPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush = false;
let loadGeneration = 0;

let snapshot: CatalogSnapshot = {
  jettons: [],
  isLoading: false,
  isFetchingMore: false,
  hasMore: true,
  error: null,
  loadedPages: 0,
};

const listeners = new Set<Listener>();

function rebuildSnapshot(): void {
  snapshot = {
    jettons: jettons.slice(),
    isLoading,
    isFetchingMore,
    hasMore,
    error,
    loadedPages: Math.max(0, nextPage - 1),
  };
}

function dedupeAppend(batch: SwapJetton[]): void {
  for (const jetton of batch) {
    const key = jetton.address?.toLowerCase();
    if (!key || seenAddresses.has(key)) continue;
    seenAddresses.add(key);
    jettons.push(jetton);
  }
}

function notifyListeners(): void {
  rebuildSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function scheduleFlush(): void {
  pendingFlush = true;
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!pendingFlush) return;
    pendingFlush = false;
    notifyListeners();
  }, UI_FLUSH_INTERVAL_MS);
}

function flushNow(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingFlush = false;
  notifyListeners();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCacheFresh(): boolean {
  return jettons.length > 0 && Date.now() - lastFetchTime < CACHE_TTL_MS;
}

function getSnapshot(): CatalogSnapshot {
  return snapshot;
}

async function fetchPage(page: number): Promise<{ items: SwapJetton[]; hasMore: boolean }> {
  const items = await fetchSwapJettonsPage(page);
  return {
    items,
    hasMore: items.length >= PAGE_SIZE,
  };
}

async function runCatalogLoad(fromScroll = false): Promise<void> {
  const generation = loadGeneration;
  const started = Date.now();
  logPageDisplay("swap_jettons_catalog_start", {
    fromScroll,
    alreadyLoaded: jettons.length,
    nextPage,
    hasMore,
  });

  if (jettons.length === 0) {
    isLoading = true;
    error = null;
    flushNow();
  } else if (hasMore) {
    isFetchingMore = true;
    scheduleFlush();
  }

  try {
    while (hasMore && nextPage <= MAX_PAGES) {
      if (generation !== loadGeneration) return;

      const page = nextPage;
      const { items, hasMore: pageHasMore } = await fetchPage(page);
      if (generation !== loadGeneration) return;

      if (items.length === 0) {
        hasMore = false;
        break;
      }

      dedupeAppend(items);
      nextPage = page + 1;
      hasMore = pageHasMore;
      lastFetchTime = Date.now();

      if (page === 1) {
        isLoading = false;
        flushNow();
        logPageDisplay("swap_jettons_catalog_first_page", {
          pageItems: items.length,
          total: jettons.length,
          elapsedMs: Date.now() - started,
        });
      } else {
        scheduleFlush();
      }

      if (!hasMore) break;

      if (fromScroll) break;

      await delay(PAGE_FETCH_DELAY_MS);
    }
    logPageDisplay("swap_jettons_catalog_done", {
      fromScroll,
      total: jettons.length,
      loadedPages: Math.max(0, nextPage - 1),
      hasMore,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    if (generation !== loadGeneration) return;
    error = err instanceof Error ? err.message : "Failed to load tokens";
    logPageDisplay("swap_jettons_catalog_error", {
      fromScroll,
      total: jettons.length,
      message: error,
      elapsedMs: Date.now() - started,
      // Keep showing rows already received; only treat as hard empty-state when nothing loaded.
      soft: jettons.length > 0,
    });
    // Partial catalog is usable — don't leave a sticky error after later page failures.
    if (jettons.length > 0) {
      error = null;
    }
    flushNow();
  } finally {
    if (generation !== loadGeneration) return;
    isLoading = false;
    isFetchingMore = false;
    flushNow();
  }
}

function resetCatalog(): void {
  loadGeneration += 1;
  jettons = [];
  seenAddresses = new Set();
  nextPage = 1;
  hasMore = true;
  isLoading = false;
  isFetchingMore = false;
  error = null;
  pendingFlush = false;
  rebuildSnapshot();
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function subscribeSwapJettonsCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSwapJettonsCatalogSnapshot(): CatalogSnapshot {
  return getSnapshot();
}

/** First page immediately; remaining pages load in the background with throttled UI updates. */
export function ensureSwapJettonsCatalogLoading(): void {
  if (isCacheFresh() && !hasMore) return;
  if (loadPromise) return;

  if (jettons.length === 0) {
    resetCatalog();
  } else if (!hasMore) {
    return;
  }

  loadPromise = runCatalogLoad(false).finally(() => {
    loadPromise = null;
  });
}

/** Called when the virtualized list nears the end — fetch the next page promptly. */
export function requestSwapJettonsNextPage(): void {
  if (!hasMore || isLoading) return;

  if (loadPromise) {
    void loadPromise.then(() => {
      if (hasMore && !isLoading && !loadPromise) {
        loadPromise = runCatalogLoad(true).finally(() => {
          loadPromise = null;
        });
      }
    });
    return;
  }

  loadPromise = runCatalogLoad(true).finally(() => {
    loadPromise = null;
  });
}

export function invalidateSwapJettonsCatalog(): void {
  resetCatalog();
  flushNow();
}

export function findSwapJettonByAddress(address: string): SwapJetton | null {
  const key = address.trim().toLowerCase();
  if (!key) return null;
  return jettons.find((j) => j.address?.toLowerCase() === key) ?? null;
}

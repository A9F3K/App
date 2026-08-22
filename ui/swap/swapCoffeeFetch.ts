import { isElectronDesktopShell } from "../appShell";
import { logPageDisplay } from "../pageDisplayLog";

const DESKTOP_TIMEOUT_MS = 45_000;
const RENDERER_TIMEOUT_MS = 12_000;
const DESKTOP_MAX_RETRIES = 3;
const RENDERER_MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

function isSwapCoffeeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".swap.coffee");
  } catch {
    return false;
  }
}

function nativeFetch(): typeof fetch {
  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    return window.fetch.bind(window);
  }
  return globalThis.fetch.bind(globalThis);
}

function mergeSwapCoffeeHeaders(init?: RequestInit, includeApiKey = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.EXPO_PUBLIC_COFFEE?.trim();
  // Browser: skip X-Api-Key so CORS stays a simple GET. DDoS-Guard often stalls OPTIONS.
  if (includeApiKey && apiKey) headers["X-Api-Key"] = apiKey;
  const fromInit = init?.headers;
  if (fromInit instanceof Headers) {
    fromInit.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (fromInit && typeof fromInit === "object") {
    Object.assign(headers, fromInit as Record<string, string>);
  }
  return headers;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function desktopSwapCoffeeFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const bridge = typeof window !== "undefined" ? window.__HSP_DESKTOP__ : undefined;
  if (!bridge?.fetchSwapCoffee) {
    throw new Error("Desktop Swap.Coffee bridge unavailable");
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DESKTOP_MAX_RETRIES; attempt += 1) {
    const started = Date.now();
    const result = await bridge.fetchSwapCoffee(url, {
      method: init?.method ?? "GET",
      headers: mergeSwapCoffeeHeaders(init, true),
      body: typeof init?.body === "string" ? init.body : undefined,
      timeoutMs,
    });

    if (result.ok) {
      logPageDisplay("swap_coffee_ipc_fetch_ok", {
        url,
        attempt,
        status: result.status ?? 200,
        elapsedMs: Date.now() - started,
      });
      return new Response(result.body ?? "", { status: result.status ?? 200 });
    }

    lastError = new Error(result.error ?? "Swap.Coffee fetch failed");
    logPageDisplay("swap_coffee_ipc_fetch_error", {
      url,
      attempt,
      elapsedMs: Date.now() - started,
      message: lastError.message,
    });
    if (attempt < DESKTOP_MAX_RETRIES) {
      await delay(RETRY_BASE_MS * attempt);
    }
  }

  throw lastError ?? new Error("Swap.Coffee fetch failed");
}

async function rendererSwapCoffeeFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const fetchImpl = nativeFetch();
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= RENDERER_MAX_RETRIES; attempt += 1) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const started = Date.now();
    try {
      const response = await withTimeout(
        fetchImpl(url, {
          ...init,
          credentials: "omit",
          signal: controller?.signal,
          headers: mergeSwapCoffeeHeaders(init, false),
        }),
        timeoutMs,
        "Swap.Coffee request",
      );
      const text = await withTimeout(response.text(), timeoutMs, "Swap.Coffee body");
      logPageDisplay("swap_coffee_renderer_fetch_ok", {
        url,
        attempt,
        status: response.status,
        bytes: text.length,
        elapsedMs: Date.now() - started,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      controller?.abort();
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`Swap.Coffee request timed out after ${timeoutMs}ms`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      logPageDisplay("swap_coffee_renderer_fetch_error", {
        url,
        attempt,
        elapsedMs: Date.now() - started,
        message: lastError.message,
      });
      if (attempt < RENDERER_MAX_RETRIES) {
        await delay(RETRY_BASE_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error("Swap.Coffee fetch failed");
}

/** Shared fetch for tokens.swap.coffee / backend.swap.coffee with desktop IPC + retries. */
export async function swapCoffeeFetch(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  if (isElectronDesktopShell() && isSwapCoffeeUrl(url)) {
    return desktopSwapCoffeeFetch(url, init, init?.timeoutMs ?? DESKTOP_TIMEOUT_MS);
  }
  return rendererSwapCoffeeFetch(url, init, init?.timeoutMs ?? RENDERER_TIMEOUT_MS);
}

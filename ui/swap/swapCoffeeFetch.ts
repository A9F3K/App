import { isElectronDesktopShell } from "../appShell";
import { logPageDisplay } from "../pageDisplayLog";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

function isSwapCoffeeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".swap.coffee");
  } catch {
    return false;
  }
}

function mergeSwapCoffeeHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.EXPO_PUBLIC_COFFEE?.trim();
  if (apiKey) headers["X-Api-Key"] = apiKey;
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
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const started = Date.now();
    const result = await bridge.fetchSwapCoffee(url, {
      method: init?.method ?? "GET",
      headers: mergeSwapCoffeeHeaders(init),
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
    if (attempt < MAX_RETRIES) {
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
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        credentials: "omit",
        signal: controller.signal,
        headers: mergeSwapCoffeeHeaders(init),
      });
      return response;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`Swap.Coffee request timed out after ${timeoutMs}ms`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      logPageDisplay("swap_coffee_renderer_fetch_error", {
        url,
        attempt,
        message: lastError.message,
      });
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_BASE_MS * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Swap.Coffee fetch failed");
}

/** Shared fetch for tokens.swap.coffee / backend.swap.coffee with desktop IPC + retries. */
export async function swapCoffeeFetch(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (isElectronDesktopShell() && isSwapCoffeeUrl(url)) {
    return desktopSwapCoffeeFetch(url, init, timeoutMs);
  }
  return rendererSwapCoffeeFetch(url, init, timeoutMs);
}

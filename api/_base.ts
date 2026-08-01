/**
 * API base URL helper used by frontend and bot.
 *
 * Priority:
 * - EXPO_PUBLIC_API_BASE_URL (explicit override for any environment)
 * - React Native / Expo Go dev: derive from dev server host (port 3000)
 * - Browser:
 *   - In dev: map localhost/LAN + dev port (8081/19000/19006) -> port 3000
 *   - In prod: window.location.origin (e.g. https://hsbexpo.vercel.app)
 * - Node (no window): Vercel host if available, otherwise http://localhost:3000
 *
 * Local web: `/api/*` is served by `vercel dev` (default http://localhost:3000). If you only run
 * `expo start --web` (port 8081) without Vercel, API fetches to :3000 return 404 or connection
 * errors — use `npm start`, `npm run web`, or `npm run dev:vercel` in another terminal. Static
 * export previews (e.g. `npx serve` on :3000) do not include serverless routes.
 */

function normalizeBase(base: string): string {
  return base.replace(/\/$/, "");
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (hostname.startsWith("10.")) return true;
  if (hostname.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  return false;
}

function getExpoNativeDevBaseUrl(): string | null {
  // Only attempt this in React Native / Expo Go.
  if (typeof navigator === "undefined" || navigator.product !== "ReactNative") {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = require("expo-constants").default as any;
    const hostUri: string | undefined =
      Constants?.expoConfig?.hostUri ??
      Constants?.manifest2?.extra?.expoGo?.developer?.hostUri;

    if (!hostUri || typeof hostUri !== "string") {
      return null;
    }

    const [hostname] = hostUri.split(":");
    if (!hostname) return null;

    return `http://${hostname}:3000`;
  } catch {
    return null;
  }
}

/** Electron packaged UI uses `app://`; file:// previews are not valid API hosts. */
function isHttpPageOrigin(): boolean {
  if (typeof window === "undefined" || !window.location?.href) return false;
  try {
    const { protocol } = new URL(window.location.href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * When the UI shell is not served over http(s) (e.g. Windows Electron `app://./`), API calls must
 * target the deployed backend from `EXPO_PUBLIC_API_BASE_URL` (baked in at export build time).
 */
function getNonHttpShellApiBaseUrl(): string | null {
  const envBase = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (envBase) {
    return normalizeBase(envBase);
  }
  if (typeof window !== "undefined" && !isHttpPageOrigin()) {
    // Last resort for desktop builds without env at compile time (set EXPO_PUBLIC_API_BASE_URL in CI).
    // Must match a BotFather Web Login Allowed URL / OIDC redirect (hsbexpo is not registered).
    return normalizeBase("https://program.hyperlinks.space");
  }
  return null;
}

function getBrowserBaseUrl(): string | null {
  if (typeof window === "undefined" || !window.location?.href) {
    return null;
  }

  try {
    const url = new URL(window.location.href);
    const { protocol, hostname, port } = url;

    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }

    // In dev, Expo often runs on 8081/19000/19006; map to 3000 for APIs.
    if (
      isPrivateOrLocalHost(hostname) &&
      (port === "8081" || port === "19000" || port === "19006")
    ) {
      return normalizeBase(`${protocol}//${hostname}:3000`);
    }

    // In production (no explicit dev port), use origin as-is.
    return normalizeBase(url.origin);
  } catch {
    return null;
  }
}

function getNodeBaseUrl(): string {
  const vercelProjectProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProjectProd) {
    return normalizeBase(`https://${vercelProjectProd}`);
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return normalizeBase(
      vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`,
    );
  }

  // Local dev fallback (vercel dev on 3000).
  return "http://localhost:3000";
}

export function getApiBaseUrl(): string {
  const envBase = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (envBase) {
    return normalizeBase(envBase);
  }

  const expoDev = getExpoNativeDevBaseUrl();
  if (expoDev) {
    return normalizeBase(expoDev);
  }

  const browserBase = getBrowserBaseUrl();
  if (browserBase) {
    return browserBase;
  }

  const shellBase = getNonHttpShellApiBaseUrl();
  if (shellBase) {
    return shellBase;
  }

  return getNodeBaseUrl();
}

export function buildApiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) {
    return path;
  }
  return `${base}${path}`;
}

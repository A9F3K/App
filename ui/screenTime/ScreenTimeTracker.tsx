/**
 * Client-side visible screen-time tracker.
 * Accrues only while the app is foreground/visible; posts capped deltas to /api/screen-time.
 */
import { useEffect, useRef } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { buildApiUrl } from "../../api/_base";
import { useAuth } from "../../auth/AuthContext";

const HEARTBEAT_MS = 30_000;
const SESSION_STORAGE_KEY = "hsp.screenTime.clientSessionId.v1";
const MAX_POST_DELTA_MS = 120_000;

function mintSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readOrCreateSessionId(): string {
  if (Platform.OS === "web" && typeof sessionStorage !== "undefined") {
    try {
      const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (existing && existing.length >= 8) return existing;
      const next = mintSessionId();
      sessionStorage.setItem(SESSION_STORAGE_KEY, next);
      return next;
    } catch {
      /* fall through */
    }
  }
  return mintSessionId();
}

function clearStoredSessionId(): void {
  if (Platform.OS === "web" && typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

function resolvePlatform(): string {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.location?.protocol === "app:") return "desktop";
    return "web";
  }
  return Platform.OS;
}

function isForegroundVisible(): boolean {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible";
  }
  return AppState.currentState === "active";
}

async function postScreenTime(body: {
  action: "heartbeat" | "end";
  client_session_id: string;
  delta_ms: number;
  platform: string;
}): Promise<void> {
  const delta = Math.max(0, Math.min(MAX_POST_DELTA_MS, Math.round(body.delta_ms)));
  const payload = JSON.stringify({ ...body, delta_ms: delta });
  const url = buildApiUrl("/api/screen-time");

  if (
    body.action === "end" &&
    Platform.OS === "web" &&
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    } catch {
      /* fall through to fetch */
    }
  }

  await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: body.action === "end",
  });
}

/** Mount once under AuthProvider — tracks authenticated visible time. */
export function ScreenTimeTracker() {
  const { isAuthenticated, authReady } = useAuth();
  const sessionIdRef = useRef<string | null>(null);
  const lastTickRef = useRef<number>(Date.now());
  const accruingRef = useRef(false);

  useEffect(() => {
    if (!authReady || !isAuthenticated) {
      sessionIdRef.current = null;
      accruingRef.current = false;
      return;
    }

    sessionIdRef.current = readOrCreateSessionId();
    lastTickRef.current = Date.now();
    accruingRef.current = isForegroundVisible();

    const flush = (end: boolean) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const now = Date.now();
      const delta = accruingRef.current ? Math.max(0, now - lastTickRef.current) : 0;
      lastTickRef.current = now;
      if (!end && delta < 1) return;
      void postScreenTime({
        action: end ? "end" : "heartbeat",
        client_session_id: id,
        delta_ms: delta,
        platform: resolvePlatform(),
      }).catch(() => {
        /* best effort */
      });
      if (end) {
        accruingRef.current = false;
      }
    };

    const onBecomeActive = () => {
      lastTickRef.current = Date.now();
      accruingRef.current = true;
      flush(false);
    };

    const onBecomeInactive = () => {
      flush(false);
      accruingRef.current = false;
    };

    // Opening heartbeat so the session row exists immediately.
    flush(false);

    const interval = setInterval(() => {
      if (!accruingRef.current) return;
      flush(false);
    }, HEARTBEAT_MS);

    let appSub: { remove: () => void } | null = null;
    if (Platform.OS === "web") {
      const onVisibility = () => {
        if (document.visibilityState === "visible") onBecomeActive();
        else onBecomeInactive();
      };
      const onPageHide = () => flush(true);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onPageHide);
      return () => {
        clearInterval(interval);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onPageHide);
        flush(true);
      };
    }

    const onAppState = (next: AppStateStatus) => {
      if (next === "active") onBecomeActive();
      else onBecomeInactive();
    };
    appSub = AppState.addEventListener("change", onAppState);
    return () => {
      clearInterval(interval);
      appSub?.remove();
      flush(true);
    };
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    if (!authReady) return;
    if (isAuthenticated) return;
    clearStoredSessionId();
  }, [authReady, isAuthenticated]);

  return null;
}

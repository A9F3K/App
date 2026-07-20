/**
 * Detects and logs main-thread freeze events during voice dialog sessions.
 *
 * Uses two complementary techniques:
 *  1. PerformanceObserver(longtask) — catches any task >50ms on the main thread.
 *  2. rAF heartbeat — catches cases where the browser simply stops calling rAF
 *     (GPU/compositor stall, renderer suspension), which longtask misses.
 *
 * All events are logged to [page-display] so they appear in the browser console
 * alongside the existing voice roster / SSE logs.
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { logPageDisplay } from "../../pageDisplayLog";

function postFreezeEvent(event: string, details: Record<string, unknown>) {
  if (typeof fetch === "undefined") return;
  fetch("/api/voice-debug", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Fire-and-forget — never await, never throw into the call stack
    body: JSON.stringify({ event, details, ts: Date.now() }),
  }).catch(() => {
    /* ignore network errors */
  });
}

/** Warn when rAF gap exceeds this threshold. */
const RAF_STALL_WARN_MS = 500;
/** Error-level freeze (controls probably unresponsive by now). */
const RAF_STALL_ERROR_MS = 1200;
/** Long-task duration above which we log at warn level. */
const LONGTASK_ERROR_MS = 400;

export function useVoiceDialogFreezeDetector(enabled: boolean): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled || Platform.OS !== "web" || typeof window === "undefined") return;

    // ── 1. PerformanceObserver: longtask ────────────────────────────────────
    let observer: PerformanceObserver | null = null;
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      try {
        observer = new PerformanceObserver((list) => {
          if (!enabledRef.current) return;
          for (const entry of list.getEntries()) {
            const durationMs = Math.round(entry.duration);
            const level = durationMs >= LONGTASK_ERROR_MS ? "error" : "warn";
            const details = {
              durationMs,
              startTimeMs: Math.round(entry.startTime),
              level,
              note:
                level === "error"
                  ? "main thread frozen ≥400ms — controls likely unresponsive"
                  : "long task >100ms during voice dialog",
            };
            logPageDisplay("voice_dialog_longtask", details);
            postFreezeEvent("voice_dialog_longtask", details);
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // Browser may not support longtask
      }
    }

    // ── 2. rAF heartbeat ────────────────────────────────────────────────────
    let rafId = 0;
    let lastRaf = performance.now();
    let totalFreezeMs = 0;
    let freezeCount = 0;

    const tick = (now: number) => {
      if (!enabledRef.current) return;
      const gap = now - lastRaf;
      if (gap > RAF_STALL_WARN_MS) {
        totalFreezeMs += gap;
        freezeCount += 1;
        const level = gap >= RAF_STALL_ERROR_MS ? "error" : "warn";
        const stallDetails = {
          gapMs: Math.round(gap),
          totalFreezeMs: Math.round(totalFreezeMs),
          freezeCount,
          level,
          note:
            level === "error"
              ? "rAF gap ≥1.2s — dialog controls blocked, compositor stalled"
              : "rAF gap >500ms — partial freeze during voice dialog",
        };
        logPageDisplay("voice_dialog_raf_stall", stallDetails);
        postFreezeEvent("voice_dialog_raf_stall", stallDetails);
      }
      lastRaf = now;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      observer?.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [enabled]);
}

/**
 * Install a one-time global freeze logger that runs for the lifetime of the
 * page (independent of component mount) and logs any longtask ≥200ms
 * with a "voice_dialog_global_longtask" prefix so you can see it even if the
 * component unmounts due to the freeze.
 */
export function installGlobalVoiceFreezeLogger(): (() => void) | undefined {
  if (
    Platform.OS !== "web" ||
    typeof window === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    return undefined;
  }
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const durationMs = Math.round(entry.duration);
        if (durationMs < 200) continue;
        const d = {
          durationMs,
          startTimeMs: Math.round(entry.startTime),
          level: durationMs >= 400 ? "error" : "warn",
        };
        logPageDisplay("voice_dialog_global_longtask", d);
        postFreezeEvent("voice_dialog_global_longtask", d);
      }
    });
    // Chrome rejects `{ entryTypes, buffered: true }` — use type API for buffer.
    try {
      obs.observe({ type: "longtask", buffered: true });
    } catch {
      obs.observe({ entryTypes: ["longtask"] });
    }
    return () => obs.disconnect();
  } catch {
    return undefined;
  }
}

/**
 * Detects and logs main-thread freeze events during voice dialog sessions.
 *
 * Uses two complementary techniques:
 *  1. PerformanceObserver(longtask) — catches heavy main-thread blocks.
 *  2. rAF heartbeat — catches compositor stalls longtask misses.
 *
 * IMPORTANT: do not POST/log every Chrome longtask (≥50ms). That feedback loop
 * (console + /api/voice-debug) was freezing the voice dialog worse than the
 * original work.
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { logPageDisplay } from "../../pageDisplayLog";
import { isVoiceDialogUiOpen } from "./voiceDialogUiGate";

let lastPostAt = 0;
const POST_MIN_INTERVAL_MS = 2_000;

function postFreezeEvent(event: string, details: Record<string, unknown>) {
  if (typeof fetch === "undefined") return;
  const now = Date.now();
  if (now - lastPostAt < POST_MIN_INTERVAL_MS) return;
  lastPostAt = now;
  fetch("/api/voice-debug", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, details, ts: now }),
  }).catch(() => {
    /* ignore network errors */
  });
}

/** Warn when rAF gap exceeds this threshold. */
const RAF_STALL_WARN_MS = 500;
/** Error-level freeze (controls probably unresponsive by now). */
const RAF_STALL_ERROR_MS = 1200;
/** Ignore routine Chrome longtasks; only surface real freezes. */
const LONGTASK_LOG_MS = 200;
const LONGTASK_ERROR_MS = 400;
/** Cap console spam while SDP/ICE churns. */
const LONGTASK_LOG_MIN_INTERVAL_MS = 750;

export function useVoiceDialogFreezeDetector(enabled: boolean): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled || Platform.OS !== "web" || typeof window === "undefined") return;

    let observer: PerformanceObserver | null = null;
    let lastLogAt = 0;
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      try {
        observer = new PerformanceObserver((list) => {
          if (!enabledRef.current) return;
          for (const entry of list.getEntries()) {
            const durationMs = Math.round(entry.duration);
            if (durationMs < LONGTASK_LOG_MS) continue;
            const now = performance.now();
            if (now - lastLogAt < LONGTASK_LOG_MIN_INTERVAL_MS && durationMs < LONGTASK_ERROR_MS) {
              continue;
            }
            lastLogAt = now;
            const level = durationMs >= LONGTASK_ERROR_MS ? "error" : "warn";
            const details = {
              durationMs,
              startTimeMs: Math.round(entry.startTime),
              level,
              note:
                level === "error"
                  ? "main thread frozen ≥400ms — controls likely unresponsive"
                  : "long task ≥200ms during voice dialog",
            };
            logPageDisplay("voice_dialog_longtask", details);
            // Console only while sheet is open — POSTing /api/voice-debug during
            // Join was part of the freeze feedback loop.
            if (level === "error" && !isVoiceDialogUiOpen()) {
              postFreezeEvent("voice_dialog_longtask", details);
            }
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // Browser may not support longtask
      }
    }

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
        if (level === "error" && !isVoiceDialogUiOpen()) {
          postFreezeEvent("voice_dialog_raf_stall", stallDetails);
        }
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
 * Global freeze logger for the page lifetime.
 * Opt-in only (`window.__HSP_VOICE_DEBUG__`) — always-on logging/POSTs were
 * stacking with chat-list paint and making hard-reload feel frozen.
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
  const debug =
    Boolean((window as { __HSP_VOICE_DEBUG__?: boolean }).__HSP_VOICE_DEBUG__);
  if (!debug) {
    return undefined;
  }
  try {
    let lastLogAt = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const durationMs = Math.round(entry.duration);
        if (durationMs < 800) continue;
        const now = performance.now();
        if (now - lastLogAt < 2_000 && durationMs < 1_200) continue;
        lastLogAt = now;
        const d = {
          durationMs,
          startTimeMs: Math.round(entry.startTime),
          level: durationMs >= 1_200 ? "error" : "warn",
        };
        logPageDisplay("voice_dialog_global_longtask", d);
      }
    });
    try {
      obs.observe({ type: "longtask", buffered: false });
    } catch {
      obs.observe({ entryTypes: ["longtask"] });
    }
    return () => obs.disconnect();
  } catch {
    return undefined;
  }
}

import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { logPageDisplay } from "../../pageDisplayLog";

type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize?: number };
};

type PerformanceObserverEntryListLike = {
  getEntries: () => ReadonlyArray<{ duration: number; startTime: number; name?: string }>;
};

/**
 * Opt-in global longtask logger (`window.__HSP_VOICE_DEBUG__ = true`).
 * Always-on observe+POST stacked with hard-reload chat paint — keep off by default.
 */
export function installGlobalVoiceFreezeLogger(): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return () => undefined;
  }
  const debugFlag = (window as unknown as { __HSP_VOICE_DEBUG__?: boolean })
    .__HSP_VOICE_DEBUG__;
  if (!debugFlag) {
    return () => undefined;
  }
  if (typeof performance === "undefined") {
    return () => undefined;
  }
  let disposed = false;
  let longtaskObserver: { disconnect: () => void } | null = null;
  try {
    const PO = (
      globalThis as unknown as {
        PerformanceObserver?: new (
          cb: (list: PerformanceObserverEntryListLike) => void,
        ) => {
          observe: (opts: { type: string; buffered?: boolean }) => void;
          disconnect: () => void;
        };
      }
    ).PerformanceObserver;
    if (PO) {
      // Never buffered:true — that replays the whole page longtask history and
      // can freeze the tab when voice debug is toggled mid-session.
      const observeStartedAt = performance.now();
      const obs = new PO((list) => {
        if (disposed) return;
        for (const entry of list.getEntries()) {
          if (entry.startTime < observeStartedAt) continue;
          if (entry.duration < 200) continue;
          const mem = (performance as PerformanceWithMemory).memory;
          logPageDisplay("voice_global_longtask", {
            durationMs: Math.round(entry.duration),
            startTimeMs: Math.round(entry.startTime),
            usedJSHeapMb:
              typeof mem?.usedJSHeapSize === "number"
                ? Math.round(mem.usedJSHeapSize / 1_048_576)
                : undefined,
            level: entry.duration >= 400 ? "error" : "warn",
            note: "opt-in __HSP_VOICE_DEBUG__ longtask",
          });
        }
      });
      obs.observe({ type: "longtask", buffered: false });
      longtaskObserver = obs;
    }
  } catch {
    // ignore
  }
  return () => {
    disposed = true;
    longtaskObserver?.disconnect();
  };
}

/**
 * Observes main-thread freezes while the voice dialog is open.
 * Logs to [page-display] so prod console dumps show when longtasks / rAF stalls
 * coincide with unresponsive Join/Leave controls.
 *
 * Optional onSevereStall: rebuild WebAudio after ≥400ms freezes (Chrome can
 * leave MediaStreamSource silent after GC / emoji decode storms).
 */
export function useVoiceDialogFreezeDetector(
  active: boolean,
  onSevereStall?: () => void,
): void {
  const onSevereStallRef = useRef(onSevereStall);
  onSevereStallRef.current = onSevereStall;
  const lastStallKickAtRef = useRef(0);

  useEffect(() => {
    if (!active || Platform.OS !== "web") return;
    if (typeof performance === "undefined" || typeof window === "undefined") return;

    let disposed = false;
    let rafId = 0;
    let lastRaf = performance.now();
    let freezeCount = 0;
    let totalFreezeMs = 0;
    let longtaskObserver: { disconnect: () => void } | null = null;

    const kickIfSevere = (durationMs: number) => {
      if (durationMs < 400) return;
      const now = Date.now();
      // Coalesce storms — at most once per 8s (was 2.5s; stall-recover
      // WebAudio rebuilds worsened freezes during join).
      if (now - lastStallKickAtRef.current < 8_000) return;
      lastStallKickAtRef.current = now;
      try {
        onSevereStallRef.current?.();
      } catch {
        // ignore
      }
    };

    const onRaf = (now: number) => {
      if (disposed) return;
      const gap = now - lastRaf;
      lastRaf = now;
      // rAF normally ~16ms; gaps >500ms mean the main thread was blocked.
      if (gap > 500) {
        freezeCount += 1;
        totalFreezeMs += gap;
        logPageDisplay("voice_dialog_raf_stall", {
          gapMs: Math.round(gap),
          totalFreezeMs: Math.round(totalFreezeMs),
          freezeCount,
          level: gap >= 1200 ? "error" : "warn",
          note:
            gap >= 1200
              ? "rAF gap ≥1.2s — dialog controls blocked, compositor stalled"
              : "rAF gap >500ms — partial freeze during voice dialog",
        });
        kickIfSevere(gap);
      }
      rafId = requestAnimationFrame(onRaf);
    };
    rafId = requestAnimationFrame(onRaf);

    // PerformanceObserver longtask (Chrome) — more precise than rAF gaps.
    try {
      const PO = (
        globalThis as unknown as {
          PerformanceObserver?: new (
            cb: (list: PerformanceObserverEntryListLike) => void,
          ) => {
            observe: (opts: { type: string; buffered?: boolean }) => void;
            disconnect: () => void;
          };
        }
      ).PerformanceObserver;
      if (PO) {
        // buffered:true replayed every longtask since page load on each dialog
        // open (identical startTimeMs spam in prod logs) and kicked stall-recover
        // WebAudio rebuilds during Join — that interrupted remote streams.
        const observeStartedAt = performance.now();
        let lastLogAt = 0;
        const obs = new PO((list) => {
          if (disposed) return;
          for (const entry of list.getEntries()) {
            if (entry.startTime < observeStartedAt) continue;
            if (entry.duration < 200) continue;
            const now = performance.now();
            // Cap log spam under freeze storms (each logPageDisplay is sync work).
            if (now - lastLogAt < 400 && entry.duration < 1200) continue;
            lastLogAt = now;
            const mem = (performance as PerformanceWithMemory).memory;
            logPageDisplay("voice_dialog_longtask", {
              durationMs: Math.round(entry.duration),
              startTimeMs: Math.round(entry.startTime),
              name: entry.name || undefined,
              usedJSHeapMb:
                typeof mem?.usedJSHeapSize === "number"
                  ? Math.round(mem.usedJSHeapSize / 1_048_576)
                  : undefined,
              level: entry.duration >= 400 ? "error" : "warn",
              note:
                entry.duration >= 400
                  ? "main thread frozen ≥400ms — controls likely unresponsive"
                  : "long task ≥200ms during voice dialog",
            });
            kickIfSevere(entry.duration);
          }
        });
        obs.observe({ type: "longtask", buffered: false });
        longtaskObserver = obs;
      }
    } catch {
      // Safari / older browsers: rAF fallback only.
    }

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      longtaskObserver?.disconnect();
    };
  }, [active]);
}

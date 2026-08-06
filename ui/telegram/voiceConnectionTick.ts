import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

/**
 * Soft clock-tick while voice ICE / media reconnects.
 * ~3 ticks/sec (every ~333ms) — quiet, not a loud alert.
 */

type TickHandle = {
  stop: () => void;
};

let active: TickHandle | null = null;

function ensureContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  unlockVoiceAutoplay();
  let ctx = getVoiceAutoplayAudioContext();
  if (!ctx || ctx.state === "closed") {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
  return ctx;
}

export function stopVoiceConnectionTick(): void {
  if (!active) return;
  active.stop();
  active = null;
}

/** Quiet fast clock ticks while connection is establishing. */
export function startVoiceConnectionTick(): void {
  stopVoiceConnectionTick();
  if (typeof document === "undefined") return;
  if (typeof AudioContext === "undefined") return;
  const ctx = ensureContext();
  if (!ctx) return;

  let stopped = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const master = ctx.createGain();
  master.gain.value = 0.035;
  master.connect(ctx.destination);

  const tick = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    osc.connect(gain);
    gain.connect(master);
    try {
      osc.start(now);
      osc.stop(now + 0.055);
    } catch {
      // ignore
    }
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // ignore
      }
    };
  };

  tick();
  // Ordinary clocks ~1/sec; 3× → ~333ms.
  intervalId = setInterval(tick, 333);

  active = {
    stop: () => {
      stopped = true;
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      try {
        master.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

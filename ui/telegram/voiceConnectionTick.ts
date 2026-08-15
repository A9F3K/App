import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

/**
 * Soft clock-tick while voice ICE / media reconnects.
 * Ordinary clocks ~1 tick/sec; 3× → every ~333ms, looped until stop.
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

/** Quiet fast clock ticks while connection is establishing / lost. */
export function startVoiceConnectionTick(): void {
  stopVoiceConnectionTick();
  if (typeof document === "undefined") return;
  if (typeof AudioContext === "undefined") return;
  const ctx = ensureContext();
  if (!ctx) return;

  let stopped = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const master = ctx.createGain();
  // Audible over a muted mix without being an alert.
  master.gain.value = 0.055;
  master.connect(ctx.destination);

  const tick = () => {
    if (stopped) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;
    // Two short clicks per tick ≈ mechanical clock (tick-tock compressed).
    const click = (at: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.038);
      osc.connect(gain);
      gain.connect(master);
      try {
        osc.start(at);
        osc.stop(at + 0.045);
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
    click(now, 980);
    click(now + 0.055, 720);
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

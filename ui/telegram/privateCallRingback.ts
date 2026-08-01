import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";
import { logPageDisplay } from "../pageDisplayLog";

/**
 * Classic PSTN / Telegram-style ringback: 440+480 Hz, ~2s on / ~4s off.
 * Uses the Join-gesture AudioContext when available so autoplay policies allow sound.
 */

type RingbackHandle = {
  stop: () => void;
};

let active: RingbackHandle | null = null;

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

export function stopPrivateCallRingback(): void {
  if (!active) return;
  active.stop();
  active = null;
  logPageDisplay("messages_private_call_ringback", { action: "stop" });
}

/** Start (or restart) ringback while dialing / ringing. No-op on native. */
export function startPrivateCallRingback(): void {
  stopPrivateCallRingback();
  if (typeof document === "undefined") return;
  // Native builds have no Web Audio ringback path yet.
  if (typeof AudioContext === "undefined") return;
  const ctx = ensureContext();
  if (!ctx) {
    logPageDisplay("messages_private_call_ringback", {
      action: "skip",
      reason: "no_audio_context",
    });
    return;
  }

  let stopped = false;
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  const oscillators: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  const clearNodes = () => {
    for (const osc of oscillators) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
      try {
        osc.disconnect();
      } catch {
        // ignore
      }
    }
    oscillators.length = 0;
    for (const g of gains) {
      try {
        g.disconnect();
      } catch {
        // ignore
      }
    }
    gains.length = 0;
  };

  const playBurst = () => {
    if (stopped) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    clearNodes();
    const now = ctx.currentTime;
    // Dual-tone ringback (ITU / North America style).
    const freqs = [440, 480];
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.08, now + 0.04);
    // 2s tone then fade
    master.gain.setValueAtTime(0.08, now + 1.85);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
    master.connect(ctx.destination);
    gains.push(master);

    for (const freq of freqs) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(master);
      osc.start(now);
      osc.stop(now + 2.05);
      oscillators.push(osc);
    }

    cycleTimer = setTimeout(() => {
      cycleTimer = null;
      if (!stopped) playBurst();
    }, 6000); // 2s on + 4s off
  };

  playBurst();
  logPageDisplay("messages_private_call_ringback", {
    action: "start",
    contextState: ctx.state,
  });

  active = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (cycleTimer != null) {
        clearTimeout(cycleTimer);
        cycleTimer = null;
      }
      clearNodes();
    },
  };
}

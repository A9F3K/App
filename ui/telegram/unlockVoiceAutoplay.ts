/** Unlock browser autoplay during a user gesture so later remote tracks can play. */

let unlockAudioEl: HTMLAudioElement | null = null;
let unlockCtx: AudioContext | null = null;

/** Shared AudioContext resumed during a user gesture — reuse for WebRTC playback. */
export function getVoiceAutoplayAudioContext(): AudioContext | null {
  if (!unlockCtx || unlockCtx.state === "closed") return null;
  return unlockCtx;
}

/** Minimal silent WAV so play() succeeds without a MediaStream. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export function unlockVoiceAutoplay(): void {
  if (typeof document === "undefined") return;

  if (!unlockAudioEl) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.muted = false;
    audio.volume = 0.01;
    audio.preload = "auto";
    audio.src = SILENT_WAV;
    audio.style.position = "fixed";
    audio.style.width = "0";
    audio.style.height = "0";
    audio.style.opacity = "0";
    audio.style.pointerEvents = "none";
    audio.setAttribute("aria-hidden", "true");
    document.body.appendChild(audio);
    unlockAudioEl = audio;
  }

  void unlockAudioEl.play().catch(() => undefined);

  if (typeof AudioContext !== "undefined") {
    try {
      if (!unlockCtx || unlockCtx.state === "closed") {
        unlockCtx = new AudioContext();
      }
      void unlockCtx.resume().catch(() => undefined);
    } catch {
      // ignore
    }
  }
}

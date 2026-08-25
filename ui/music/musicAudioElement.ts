/** Dedicated music HTMLAudioElement — never the voice-call AudioContext. */

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let musicEl: HTMLAudioElement | null = null;
/** Separate element so gesture unlock never clobbers the track `src` mid-load. */
let unlockEl: HTMLAudioElement | null = null;

function ensureHiddenAudio(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");
  audio.setAttribute("webkit-playsinline", "true");
  audio.style.position = "fixed";
  audio.style.width = "0";
  audio.style.height = "0";
  audio.style.opacity = "0";
  audio.style.pointerEvents = "none";
  audio.setAttribute("aria-hidden", "true");
  document.body.appendChild(audio);
  return audio;
}

export function getMusicAudioElement(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  if (musicEl && musicEl.isConnected) return musicEl;
  musicEl = ensureHiddenAudio();
  return musicEl;
}

/** Call from a click/tap so later play() is allowed. Does not touch voice audio. */
export function unlockMusicAutoplay(): void {
  if (typeof document === "undefined") return;
  if (!unlockEl || !unlockEl.isConnected) {
    unlockEl = ensureHiddenAudio();
  }
  const audio = unlockEl;
  if (!audio) return;
  if (!audio.src) {
    audio.src = SILENT_WAV;
  }
  void audio.play().catch(() => undefined);
}

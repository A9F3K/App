/** Dedicated music HTMLAudioElement — never the voice-call AudioContext. */

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let musicEl: HTMLAudioElement | null = null;

export function getMusicAudioElement(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  if (musicEl && musicEl.isConnected) return musicEl;
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
  musicEl = audio;
  return audio;
}

/** Call from a click/tap so later play() is allowed. Does not touch voice audio. */
export function unlockMusicAutoplay(): void {
  const audio = getMusicAudioElement();
  if (!audio) return;
  const src = audio.getAttribute("src") || audio.src || "";
  if (!src || src.startsWith("data:")) {
    audio.src = SILENT_WAV;
  }
  void audio.play().catch(() => undefined);
}

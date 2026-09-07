import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import {
  musicTrackPlaybackKey,
  musicTrackPlaybackUrl,
} from "../telegram/fetchTelegramUserProfile";
import { logPageDisplay } from "../pageDisplayLog";
import { getMusicAudioElement } from "./musicAudioElement";
import {
  consumeMusicSeek,
  getMusicPlayer,
  handleMusicEnded,
  reportMusicTime,
  seekMusicSeconds,
  setMusicPlaying,
  subscribeMusicPlayer,
} from "./musicPlayerStore";

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MAX_RECOVER_ATTEMPTS = 3;

function mediaDurationSec(audio: HTMLAudioElement, fallback: number): number {
  const duration = audio.duration;
  if (Number.isFinite(duration) && duration > 0) return duration;
  try {
    if (audio.seekable && audio.seekable.length > 0) {
      const end = audio.seekable.end(audio.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
  } catch {
    // ignore
  }
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function applyCurrentTime(audio: HTMLAudioElement, seconds: number): boolean {
  try {
    audio.currentTime = Math.max(0, seconds);
    return true;
  } catch {
    return false;
  }
}

function withCacheBust(src: string, attempt: number): string {
  const join = src.includes("?") ? "&" : "?";
  return `${src}${join}_mr=${attempt}_${Date.now()}`;
}

/**
 * Dedicated HTMLAudioElement — never shares the voice-call AudioContext.
 * Music and group/private calls can play at the same time.
 */
export function MusicPlayerEngine(): null {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedKeyRef = useRef<string>("");
  const loadSeqRef = useRef(0);
  const loadStartedAtRef = useRef(0);
  const lastGoodTimeRef = useRef(0);
  const recoverAttemptsRef = useRef(0);
  const recoveringRef = useRef(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const audio = getMusicAudioElement();
    if (!audio) return;
    audioRef.current = audio;
    audio.crossOrigin = "use-credentials";
    audio.preload = "auto";

    const revokeBlobUrl = () => {
      if (!blobUrlRef.current) return;
      try {
        URL.revokeObjectURL(blobUrlRef.current);
      } catch {
        // ignore
      }
      blobUrlRef.current = null;
    };

    let appliedVolume = audio.volume;
    let volumeRaf = 0;
    const tickVolume = () => {
      const snap = getMusicPlayer();
      const target = snap.muted ? 0 : snap.volume;
      appliedVolume += (target - appliedVolume) * 0.22;
      if (Math.abs(target - appliedVolume) < 0.003) appliedVolume = target;
      audio.volume = Math.max(0, Math.min(1, appliedVolume));
      volumeRaf = requestAnimationFrame(tickVolume);
    };
    volumeRaf = requestAnimationFrame(tickVolume);

    const onTime = () => {
      const t = audio.currentTime || 0;
      if (Number.isFinite(t) && t > 0) lastGoodTimeRef.current = t;
      reportMusicTime(t, audio.duration || 0);
    };
    const onEnded = () => {
      handleMusicEnded();
    };
    const onSeeked = () => {
      const snap = getMusicPlayer();
      if (snap.seekTo == null) return;
      if (Math.abs((audio.currentTime || 0) - snap.seekTo) < 0.75) {
        consumeMusicSeek();
      }
    };
    const onPlaying = () => {
      if (!loadStartedAtRef.current) return;
      logPageDisplay("music_playback_started", {
        key: loadedKeyRef.current,
        elapsedMs: Date.now() - loadStartedAtRef.current,
        readyState: audio.readyState,
        networkState: audio.networkState,
      });
      loadStartedAtRef.current = 0;
    };

    let lastSeekSeq = -1;
    const tryPlay = () => {
      const snap = getMusicPlayer();
      if (!snap.playing || !snap.visible) return;
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch((err: unknown) => {
          const name =
            err && typeof err === "object" && "name" in err ? String(err.name) : "";
          if (name === "AbortError" || name === "NotAllowedError") return;
          if (recoveringRef.current) return;
          setMusicPlaying(false);
        });
      }
    };

    const applyPlayback = () => {
      if (recoveringRef.current) return;
      const snap = getMusicPlayer();
      audio.playbackRate = snap.speed;
      audio.loop = snap.loopMode === "one";

      if (snap.seekTo != null) {
        const duration = mediaDurationSec(audio, snap.duration);
        const target = duration > 0 ? Math.min(snap.seekTo, duration) : snap.seekTo;
        const alreadyThere = Math.abs((audio.currentTime || 0) - target) < 0.35;
        if (alreadyThere) {
          consumeMusicSeek();
        } else if (lastSeekSeq !== snap.seekSeq || Math.abs((audio.currentTime || 0) - target) > 0.75) {
          lastSeekSeq = snap.seekSeq;
          applyCurrentTime(audio, target);
          if (Math.abs((audio.currentTime || 0) - target) < 0.35) {
            consumeMusicSeek();
          }
        }
      }

      if (!snap.visible || snap.tracks.length === 0) {
        audio.pause();
        return;
      }

      if (snap.playing) {
        tryPlay();
      } else if (!audio.paused) {
        audio.pause();
      }
    };

    const attachReadyOnce = (seq: number, onReady: () => void) => {
      const fire = () => {
        if (seq !== loadSeqRef.current) return;
        onReady();
      };
      audio.addEventListener("canplay", fire, { once: true });
      audio.addEventListener("loadeddata", fire, { once: true });
    };

    const recoverPlayback = async (code: number | null) => {
      const snap = getMusicPlayer();
      const track = snap.tracks[snap.index] ?? null;
      const key = loadedKeyRef.current;
      if (!track || !key || recoveringRef.current) return false;
      if (recoverAttemptsRef.current >= MAX_RECOVER_ATTEMPTS) return false;

      const attempt = ++recoverAttemptsRef.current;
      recoveringRef.current = true;
      // Skip a few frames past the bad packet; Chromium decode errors often stick on one frame.
      const resumeAt = Math.max(0, lastGoodTimeRef.current + 0.12);
      logPageDisplay("music_playback_recover", {
        key,
        attempt,
        code,
        resumeAt,
      });

      const seq = ++loadSeqRef.current;
      loadStartedAtRef.current = Date.now();
      const baseSrc = musicTrackPlaybackUrl(track);

      try {
        audio.pause();
        revokeBlobUrl();
        // Prefer a full blob remount after decode/network failure so progressive
        // range/buffer corruption cannot stick on the same HTMLMediaElement pipeline.
        const response = await fetch(baseSrc, {
          credentials: "include",
          cache: "reload",
        });
        if (!response.ok) throw new Error(`recover_http_${response.status}`);
        const blob = await response.blob();
        if (seq !== loadSeqRef.current) return false;
        const objectUrl = URL.createObjectURL(blob);
        blobUrlRef.current = objectUrl;
        audio.src = objectUrl;
        audio.load();
        attachReadyOnce(seq, () => {
          logPageDisplay("music_track_canplay", {
            key,
            recovered: true,
            attempt,
            elapsedMs: Date.now() - loadStartedAtRef.current,
            readyState: audio.readyState,
          });
          seekMusicSeconds(resumeAt, true);
          applyCurrentTime(audio, resumeAt);
          recoveringRef.current = false;
          applyPlayback();
        });
        return true;
      } catch (err) {
        if (seq !== loadSeqRef.current) return false;
        logPageDisplay("music_playback_recover_fallback", {
          key,
          attempt,
          message: err instanceof Error ? err.message : String(err),
        });
        // Stream reload with cache-bust if blob fetch failed (timeout / size).
        audio.src = withCacheBust(baseSrc, attempt);
        audio.load();
        attachReadyOnce(seq, () => {
          seekMusicSeconds(resumeAt, true);
          applyCurrentTime(audio, resumeAt);
          recoveringRef.current = false;
          applyPlayback();
        });
        return true;
      }
    };

    const onError = () => {
      const code = audio.error?.code ?? null;
      const key = loadedKeyRef.current;
      logPageDisplay("music_playback_error", {
        key,
        code,
        message: audio.error?.message ?? null,
        currentTime: audio.currentTime || 0,
        lastGoodTime: lastGoodTimeRef.current,
        recoverAttempt: recoverAttemptsRef.current,
        elapsedMs: loadStartedAtRef.current
          ? Date.now() - loadStartedAtRef.current
          : null,
      });

      const snap = getMusicPlayer();
      const recoverable =
        (code === MEDIA_ERR_NETWORK || code === MEDIA_ERR_DECODE) &&
        snap.playing &&
        snap.visible &&
        Boolean(key) &&
        !recoveringRef.current &&
        recoverAttemptsRef.current < MAX_RECOVER_ATTEMPTS;

      if (recoverable) {
        void recoverPlayback(code).then((ok) => {
          if (!ok) {
            recoveringRef.current = false;
            setMusicPlaying(false);
          }
        });
        return;
      }

      recoveringRef.current = false;
      setMusicPlaying(false);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onTime);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("playing", onPlaying);

    const apply = () => {
      const snap = getMusicPlayer();
      const track = snap.tracks[snap.index] ?? null;
      const key = track ? musicTrackPlaybackKey(track) : "";

      if (!snap.visible || !track) {
        if (loadedKeyRef.current) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          loadedKeyRef.current = "";
          recoverAttemptsRef.current = 0;
          recoveringRef.current = false;
          lastGoodTimeRef.current = 0;
          revokeBlobUrl();
        }
        return;
      }

      if (loadedKeyRef.current !== key) {
        const seq = ++loadSeqRef.current;
        loadedKeyRef.current = key;
        recoverAttemptsRef.current = 0;
        recoveringRef.current = false;
        lastGoodTimeRef.current = 0;
        revokeBlobUrl();
        loadStartedAtRef.current = Date.now();
        const src = musicTrackPlaybackUrl(track);
        logPageDisplay("music_track_load_start", {
          key,
          playing: snap.playing,
          srcHost: (() => {
            try {
              return new URL(src, window.location.href).host;
            } catch {
              return null;
            }
          })(),
        });
        audio.pause();
        // Always assign + load so a prior unlock/silent src cannot stick.
        audio.src = src;
        audio.load();
        attachReadyOnce(seq, () => {
          logPageDisplay("music_track_canplay", {
            key,
            elapsedMs: Date.now() - loadStartedAtRef.current,
            readyState: audio.readyState,
          });
          applyPlayback();
        });
        // Optimistic play — browsers start as soon as enough bytes arrive.
        tryPlay();
        return;
      }

      if (!recoveringRef.current) applyPlayback();
    };

    audio.addEventListener("progress", applyPlayback);
    audio.addEventListener("canplay", applyPlayback);
    audio.addEventListener("canplaythrough", applyPlayback);

    const unsubscribe = subscribeMusicPlayer(apply);
    apply();

    return () => {
      cancelAnimationFrame(volumeRaf);
      unsubscribe();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onTime);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("progress", applyPlayback);
      audio.removeEventListener("canplay", applyPlayback);
      audio.removeEventListener("canplaythrough", applyPlayback);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      revokeBlobUrl();
      audioRef.current = null;
      loadedKeyRef.current = "";
      recoveringRef.current = false;
    };
  }, []);

  return null;
}

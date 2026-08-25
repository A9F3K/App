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
  setMusicPlaying,
  subscribeMusicPlayer,
} from "./musicPlayerStore";

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

/**
 * Dedicated HTMLAudioElement — never shares the voice-call AudioContext.
 * Music and group/private calls can play at the same time.
 */
export function MusicPlayerEngine(): null {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedKeyRef = useRef<string>("");
  const loadSeqRef = useRef(0);
  const loadStartedAtRef = useRef(0);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const audio = getMusicAudioElement();
    if (!audio) return;
    audioRef.current = audio;
    audio.crossOrigin = "use-credentials";
    audio.preload = "auto";

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
      reportMusicTime(audio.currentTime || 0, audio.duration || 0);
    };
    const onEnded = () => {
      handleMusicEnded();
    };
    const onError = () => {
      logPageDisplay("music_playback_error", {
        key: loadedKeyRef.current,
        code: audio.error?.code ?? null,
        message: audio.error?.message ?? null,
        elapsedMs: loadStartedAtRef.current
          ? Date.now() - loadStartedAtRef.current
          : null,
      });
      setMusicPlaying(false);
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
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onTime);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("playing", onPlaying);

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
          setMusicPlaying(false);
        });
      }
    };

    const applyPlayback = () => {
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
        }
        return;
      }

      if (loadedKeyRef.current !== key) {
        const seq = ++loadSeqRef.current;
        loadedKeyRef.current = key;
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
        const onReady = () => {
          if (seq !== loadSeqRef.current) return;
          logPageDisplay("music_track_canplay", {
            key,
            elapsedMs: Date.now() - loadStartedAtRef.current,
            readyState: audio.readyState,
          });
          applyPlayback();
        };
        audio.addEventListener("canplay", onReady, { once: true });
        audio.addEventListener("loadeddata", onReady, { once: true });
        // Optimistic play — browsers start as soon as enough bytes arrive.
        tryPlay();
        return;
      }

      applyPlayback();
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
      audioRef.current = null;
      loadedKeyRef.current = "";
    };
  }, []);

  return null;
}

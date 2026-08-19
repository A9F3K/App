import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import {
  musicTrackPlaybackKey,
  musicTrackPlaybackUrl,
} from "../telegram/fetchTelegramUserProfile";
import { getMusicAudioElement } from "./musicAudioElement";
import {
  consumeMusicSeek,
  getMusicPlayer,
  handleMusicEnded,
  reportMusicTime,
  setMusicPlaying,
  subscribeMusicPlayer,
} from "./musicPlayerStore";

/**
 * Dedicated HTMLAudioElement — never shares the voice-call AudioContext.
 * Music and group/private calls can play at the same time.
 */
export function MusicPlayerEngine(): null {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedKeyRef = useRef<string>("");
  const loadingKeyRef = useRef<string>("");
  const objectUrlRef = useRef<string>("");
  const loadSeqRef = useRef(0);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const audio = getMusicAudioElement();
    if (!audio) return;
    audioRef.current = audio;

    const revokeObjectUrl = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = "";
      }
    };

    const onTime = () => {
      reportMusicTime(audio.currentTime || 0, audio.duration || 0);
    };
    const onEnded = () => {
      handleMusicEnded();
    };
    const onError = () => {
      setMusicPlaying(false);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onTime);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    const applyPlayback = () => {
      const snap = getMusicPlayer();
      audio.volume = snap.muted ? 0 : snap.volume;
      audio.playbackRate = snap.speed;
      audio.loop = snap.loopMode === "one";

      if (snap.seekTo != null) {
        try {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = Math.min(snap.seekTo, audio.duration);
            consumeMusicSeek();
          }
        } catch {
          // duration not ready yet
        }
      }

      if (!snap.visible || snap.tracks.length === 0) {
        audio.pause();
        return;
      }

      if (snap.playing) {
        const playResult = audio.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch((err: unknown) => {
            const name =
              err && typeof err === "object" && "name" in err ? String(err.name) : "";
            if (name === "AbortError" || name === "NotAllowedError") return;
            setMusicPlaying(false);
          });
        }
      } else if (!audio.paused) {
        audio.pause();
      }
    };

    const waitForCanPlay = (el: HTMLAudioElement): Promise<void> =>
      new Promise((resolve, reject) => {
        if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          resolve();
          return;
        }
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onFail = () => {
          cleanup();
          reject(new Error("audio_load_failed"));
        };
        const cleanup = () => {
          el.removeEventListener("canplay", onReady);
          el.removeEventListener("loadeddata", onReady);
          el.removeEventListener("error", onFail);
        };
        el.addEventListener("canplay", onReady);
        el.addEventListener("loadeddata", onReady);
        el.addEventListener("error", onFail);
      });

    const loadTrack = (key: string, src: string) => {
      if (loadingKeyRef.current === key) return;
      loadingKeyRef.current = key;
      const seq = ++loadSeqRef.current;
      void (async () => {
        try {
          const response = await fetch(src, { credentials: "include" });
          if (!response.ok) throw new Error("audio_unavailable");
          const blob = await response.blob();
          if (seq !== loadSeqRef.current) return;
          revokeObjectUrl();
          const objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          audio.pause();
          audio.src = objectUrl;
          audio.load();
          await waitForCanPlay(audio);
          if (seq !== loadSeqRef.current) return;
          loadedKeyRef.current = key;
          loadingKeyRef.current = "";
          applyPlayback();
        } catch {
          if (seq !== loadSeqRef.current) return;
          loadingKeyRef.current = "";
          if (loadedKeyRef.current === key) {
            loadedKeyRef.current = "";
          }
          setMusicPlaying(false);
        }
      })();
    };

    const apply = () => {
      const snap = getMusicPlayer();
      const track = snap.tracks[snap.index] ?? null;
      const key = track ? musicTrackPlaybackKey(track) : "";

      if (!snap.visible || !track) {
        if (loadedKeyRef.current || loadingKeyRef.current) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          loadedKeyRef.current = "";
          loadingKeyRef.current = "";
          revokeObjectUrl();
        }
        return;
      }

      if (loadedKeyRef.current !== key) {
        if (loadingKeyRef.current !== key) {
          loadTrack(key, musicTrackPlaybackUrl(track));
        }
        return;
      }

      applyPlayback();
    };

    const unsubscribe = subscribeMusicPlayer(apply);
    apply();

    return () => {
      unsubscribe();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onTime);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
      loadedKeyRef.current = "";
      loadingKeyRef.current = "";
      revokeObjectUrl();
    };
  }, []);

  return null;
}

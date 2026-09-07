import type { TelegramProfileAudioTrack } from "../telegram/fetchTelegramUserProfile";

export const MUSIC_CONTROL_BAR_HEIGHT_PX = 30;

export type MusicLoopMode = "off" | "one" | "all";

export const MUSIC_LOOP_MODES: readonly MusicLoopMode[] = ["off", "one", "all"];

export function nextMusicLoopMode(mode: MusicLoopMode): MusicLoopMode {
  const index = MUSIC_LOOP_MODES.indexOf(mode);
  return MUSIC_LOOP_MODES[(index < 0 ? 0 : index + 1) % MUSIC_LOOP_MODES.length]!;
}

export const MUSIC_SPEEDS = [0.5, 1, 1.2, 1.5, 1.7, 2] as const;

export type MusicSpeed = (typeof MUSIC_SPEEDS)[number];

export function nextMusicSpeed(speed: number): MusicSpeed {
  const index = MUSIC_SPEEDS.findIndex((value) => value === speed);
  return MUSIC_SPEEDS[(index < 0 ? 0 : index + 1) % MUSIC_SPEEDS.length]!;
}

export function formatMusicSpeedLabel(speed: number): string {
  if (speed === 1) return "1X";
  if (speed === 2) return "2X";
  const rounded = Number.isInteger(speed) ? String(speed) : String(speed);
  return `${rounded}X`;
}

export type MusicPlayerSnapshot = {
  visible: boolean;
  tracks: TelegramProfileAudioTrack[];
  index: number;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  loopMode: MusicLoopMode;
  speed: MusicSpeed;
  order: number[];
  seekTo: number | null;
  seekSeq: number;
};

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: MusicPlayerSnapshot = {
  visible: false,
  tracks: [],
  index: 0,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  shuffle: false,
  loopMode: "off",
  speed: 1,
  order: [],
  seekTo: null,
  seekSeq: 0,
};

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function setSnapshot(patch: Partial<MusicPlayerSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

function linearOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

function shuffledOrder(length: number, keepIndex?: number): number[] {
  const order = linearOrder(length);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  if (keepIndex != null && keepIndex >= 0 && keepIndex < length) {
    const pos = order.indexOf(keepIndex);
    if (pos > 0) {
      order[pos] = order[0]!;
      order[0] = keepIndex;
    }
  }
  return order;
}

function rebuildOrder(
  length: number,
  shuffle: boolean,
  keepIndex: number,
): number[] {
  if (length <= 0) return [];
  return shuffle ? shuffledOrder(length, keepIndex) : linearOrder(length);
}

export function getMusicPlayer(): MusicPlayerSnapshot {
  return snapshot;
}

export function subscribeMusicPlayer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isMusicPlayerVisible(): boolean {
  return snapshot.visible;
}

export function startMusicPlaylist(
  tracks: TelegramProfileAudioTrack[],
  startIndex = 0,
): void {
  if (tracks.length === 0) return;
  const index = Math.max(0, Math.min(Math.trunc(startIndex), tracks.length - 1));
  const order = rebuildOrder(tracks.length, snapshot.shuffle, index);
  setSnapshot({
    visible: true,
    tracks,
    index,
    playing: true,
    currentTime: 0,
    duration: tracks[index]?.duration_sec ?? 0,
    order,
    seekTo: 0,
    seekSeq: snapshot.seekSeq + 1,
  });
}

export function setMusicTracks(tracks: TelegramProfileAudioTrack[], keepFileId?: number): void {
  if (tracks.length === 0) {
    setSnapshot({ tracks: [], order: [], index: 0, playing: false, visible: false });
    return;
  }
  const current = snapshot.tracks[snapshot.index] ?? null;
  let keepIndex =
    keepFileId != null ? tracks.findIndex((row) => row.file_id === keepFileId) : -1;
  if (keepIndex < 0 && current) {
    keepIndex = tracks.findIndex(
      (row) =>
        row.file_id === current.file_id &&
        row.user_id === current.user_id,
    );
  }
  if (keepIndex < 0 && current) {
    const next = [
      current,
      ...tracks.filter(
        (row) => !(row.file_id === current.file_id && row.user_id === current.user_id),
      ),
    ];
    setSnapshot({
      tracks: next,
      index: 0,
      order: rebuildOrder(next.length, snapshot.shuffle, 0),
    });
    return;
  }
  const index = keepIndex >= 0 ? keepIndex : snapshot.index < tracks.length ? snapshot.index : 0;
  setSnapshot({
    tracks,
    index,
    order: rebuildOrder(tracks.length, snapshot.shuffle, index),
  });
}

export function toggleMusicPlay(): void {
  if (!snapshot.visible || snapshot.tracks.length === 0) return;
  setSnapshot({ playing: !snapshot.playing });
}

export function setMusicPlaying(playing: boolean): void {
  if (!snapshot.visible) return;
  setSnapshot({ playing });
}

export function playMusicIndex(index: number): void {
  if (!snapshot.visible || snapshot.tracks.length === 0) return;
  const next = Math.max(0, Math.min(Math.trunc(index), snapshot.tracks.length - 1));
  setSnapshot({
    index: next,
    playing: true,
    currentTime: 0,
    duration: snapshot.tracks[next]?.duration_sec ?? 0,
    seekTo: 0,
    seekSeq: snapshot.seekSeq + 1,
  });
}

function stepTrack(delta: number): void {
  const { tracks, order, index, loopMode } = snapshot;
  if (tracks.length === 0) return;
  const queue = order.length === tracks.length ? order : linearOrder(tracks.length);
  const pos = queue.indexOf(index);
  const at = pos >= 0 ? pos : 0;
  let nextPos = at + delta;
  if (loopMode === "all") {
    nextPos = ((nextPos % queue.length) + queue.length) % queue.length;
  } else if (nextPos < 0 || nextPos >= queue.length) {
    setSnapshot({ playing: false, currentTime: delta > 0 ? snapshot.duration : 0 });
    return;
  }
  const nextIndex = queue[nextPos] ?? index;
  setSnapshot({
    index: nextIndex,
    playing: true,
    currentTime: 0,
    duration: tracks[nextIndex]?.duration_sec ?? 0,
    seekTo: 0,
    seekSeq: snapshot.seekSeq + 1,
  });
}

export function playMusicNext(): void {
  stepTrack(1);
}

export function playMusicPrev(): void {
  if (snapshot.currentTime > 3) {
    setSnapshot({
      currentTime: 0,
      seekTo: 0,
      seekSeq: snapshot.seekSeq + 1,
    });
    return;
  }
  stepTrack(-1);
}

export function handleMusicEnded(): void {
  if (snapshot.loopMode === "one") {
    setSnapshot({
      currentTime: 0,
      playing: true,
      seekTo: 0,
      seekSeq: snapshot.seekSeq + 1,
    });
    return;
  }
  stepTrack(1);
}

export function cycleMusicLoopMode(): void {
  setSnapshot({ loopMode: nextMusicLoopMode(snapshot.loopMode) });
}

export function cycleMusicSpeed(): void {
  setSnapshot({ speed: nextMusicSpeed(snapshot.speed) });
}

export function toggleMusicShuffle(): void {
  const shuffle = !snapshot.shuffle;
  setSnapshot({
    shuffle,
    order: rebuildOrder(snapshot.tracks.length, shuffle, snapshot.index),
  });
}

export function setMusicVolume(volume: number): void {
  const next = Math.max(0, Math.min(1, volume));
  setSnapshot({ volume: next, muted: next <= 0 });
}

export function setMusicMuted(muted: boolean): void {
  setSnapshot({ muted });
}

export function seekMusicRatio(ratio: number): void {
  const track = snapshot.tracks[snapshot.index];
  const duration =
    snapshot.duration > 0
      ? snapshot.duration
      : Number(track?.duration_sec) > 0
        ? Number(track?.duration_sec)
        : 0;
  if (!(duration > 0)) return;
  const next = Math.max(0, Math.min(1, ratio)) * duration;
  setSnapshot({
    currentTime: next,
    duration,
    seekTo: next,
    seekSeq: snapshot.seekSeq + 1,
    playing: true,
  });
}

/** Seek to an absolute time (seconds) and keep / resume playback. */
export function seekMusicSeconds(seconds: number, playing = true): void {
  if (!snapshot.visible || snapshot.tracks.length === 0) return;
  const track = snapshot.tracks[snapshot.index];
  const duration =
    snapshot.duration > 0
      ? snapshot.duration
      : Number(track?.duration_sec) > 0
        ? Number(track?.duration_sec)
        : 0;
  const next =
    duration > 0
      ? Math.max(0, Math.min(duration, seconds))
      : Math.max(0, seconds);
  setSnapshot({
    currentTime: next,
    duration: duration > 0 ? duration : snapshot.duration,
    seekTo: next,
    seekSeq: snapshot.seekSeq + 1,
    playing,
  });
}

export function reportMusicTime(currentTime: number, duration: number): void {
  const nextDuration =
    Number.isFinite(duration) && duration > 0 ? duration : snapshot.duration;
  if (snapshot.seekTo != null) {
    if (Math.abs(nextDuration - snapshot.duration) < 0.2) return;
    setSnapshot({ duration: nextDuration });
    return;
  }
  if (
    Math.abs(currentTime - snapshot.currentTime) < 0.2 &&
    Math.abs(nextDuration - snapshot.duration) < 0.2
  ) {
    return;
  }
  setSnapshot({ currentTime, duration: nextDuration });
}

export function consumeMusicSeek(): void {
  if (snapshot.seekTo == null) return;
  setSnapshot({ seekTo: null });
}

export function closeMusicPlayer(): void {
  setSnapshot({
    visible: false,
    playing: false,
    currentTime: 0,
  });
}

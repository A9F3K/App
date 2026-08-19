function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fileIdFromUnknown(value: unknown): number | null {
  const rec = asRecord(value);
  const id = Number(rec?.id);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function fileSizeFromUnknown(value: unknown): number {
  const rec = asRecord(value);
  const size = Number(rec?.size ?? rec?.expected_size ?? 0);
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
}

function minithumbnailDataUrl(value: unknown): string | null {
  const rec = asRecord(value);
  const data = rec?.data;
  if (typeof data === "string" && data.trim()) {
    const raw = data.trim();
    if (raw.startsWith("data:")) return raw;
    return `data:image/jpeg;base64,${raw}`;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data) && data.length > 0) {
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  }
  return null;
}

export type TdAudioMeta = {
  artist: string;
  title: string;
  duration_sec: number;
  size_bytes: number;
  cover_data_url: string | null;
  file_id: number | null;
  cover_file_id: number | null;
};

function audioObjectFromUnknown(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec._ === "messageAudio") return asRecord(rec.audio);
  if (rec.audio && asRecord(rec.audio)?.performer != null) return asRecord(rec.audio);
  if (typeof rec.performer === "string" || typeof rec.title === "string") return rec;
  return asRecord(rec.audio);
}

export function parseTdAudioMeta(value: unknown): TdAudioMeta | null {
  const audio = audioObjectFromUnknown(value);
  if (!audio) return null;
  const file = audio.audio ?? audio.file;
  const fileId = fileIdFromUnknown(file);
  const artist =
    (typeof audio.performer === "string" && audio.performer.trim()) ||
    (typeof audio.artist === "string" && audio.artist.trim()) ||
    "";
  const title =
    (typeof audio.title === "string" && audio.title.trim()) ||
    (typeof audio.file_name === "string" && audio.file_name.trim()) ||
    "";
  if (!artist && !title && fileId == null) return null;
  const duration = Number(audio.duration);
  const thumb = asRecord(audio.album_cover_thumbnail);
  return {
    artist: artist || title,
    title: artist && title ? title : "",
    duration_sec: Number.isFinite(duration) && duration > 0 ? Math.trunc(duration) : 0,
    size_bytes: fileSizeFromUnknown(file),
    cover_data_url: minithumbnailDataUrl(audio.album_cover_minithumbnail),
    file_id: fileId,
    cover_file_id: fileIdFromUnknown(thumb?.file ?? thumb?.photo),
  };
}

export function audioDisplayLabel(meta: TdAudioMeta): string {
  if (meta.title && meta.artist && meta.artist !== meta.title) {
    return `${meta.artist} – ${meta.title}`;
  }
  return meta.artist || meta.title || "Audio";
}

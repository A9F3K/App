/**
 * Account-scoped listen preferences for voice-chat peers.
 *
 * TDLib already stores per-participant volume_level (1 = muted-for-me) on the
 * Telegram account for the active call. We also persist intentional mutes here
 * so that:
 *  - volume_level=1 from a stale SFU default can be reset to 100% on join
 *  - peers the user explicitly muted stay muted (and show red mic) across rejoins
 *  - local video/screen hide prefs survive sheet remounts
 *
 * Keyed by Telegram account identity (username when known).
 */

export type StoredVoicePeerMediaPrefs = {
  /** User explicitly muted this peer's voice for themselves. */
  voiceMuted: boolean;
  /** Last non-zero volume % for unmute restore (1–200). */
  volumePercent?: number;
  muteVideo?: boolean;
  muteScreen?: boolean;
};

type StoreShape = {
  v: 1;
  peers: Record<string, StoredVoicePeerMediaPrefs>;
};

const STORE_PREFIX = "hsp.voicePeerMediaPrefs.v1.";

function normalizeAccountId(accountId: string | null | undefined): string {
  const raw = typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
  return raw.length > 0 ? raw : "anon";
}

function storageKey(accountId: string | null | undefined): string {
  return `${STORE_PREFIX}${normalizeAccountId(accountId)}`;
}

function readStore(accountId: string | null | undefined): StoreShape {
  try {
    if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
      return { v: 1, peers: {} };
    }
    const raw = (
      globalThis as unknown as { localStorage: Storage }
    ).localStorage.getItem(storageKey(accountId));
    if (!raw) return { v: 1, peers: {} };
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) {
      return { v: 1, peers: {} };
    }
    const peers =
      parsed.peers && typeof parsed.peers === "object" && !Array.isArray(parsed.peers)
        ? parsed.peers
        : {};
    const cleaned: Record<string, StoredVoicePeerMediaPrefs> = {};
    for (const [key, value] of Object.entries(peers)) {
      if (!value || typeof value !== "object") continue;
      cleaned[key] = {
        voiceMuted: Boolean(value.voiceMuted),
        volumePercent:
          typeof value.volumePercent === "number" &&
          Number.isFinite(value.volumePercent) &&
          value.volumePercent > 0
            ? Math.min(200, Math.max(1, Math.round(value.volumePercent)))
            : undefined,
        muteVideo: value.muteVideo === true ? true : undefined,
        muteScreen: value.muteScreen === true ? true : undefined,
      };
    }
    return { v: 1, peers: cleaned };
  } catch {
    return { v: 1, peers: {} };
  }
}

function writeStore(accountId: string | null | undefined, store: StoreShape): void {
  try {
    if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) return;
    const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
    // Drop empty peers to keep the blob small.
    const peers: Record<string, StoredVoicePeerMediaPrefs> = {};
    for (const [key, value] of Object.entries(store.peers)) {
      if (
        !value.voiceMuted &&
        value.muteVideo !== true &&
        value.muteScreen !== true &&
        value.volumePercent == null
      ) {
        continue;
      }
      peers[key] = value;
    }
    if (Object.keys(peers).length === 0) {
      ls.removeItem(storageKey(accountId));
      return;
    }
    ls.setItem(storageKey(accountId), JSON.stringify({ v: 1, peers }));
  } catch {
    /* private mode / SSR */
  }
}

export function readStoredVoicePeerMediaPrefs(
  accountId: string | null | undefined,
  peerKey: string,
): StoredVoicePeerMediaPrefs | null {
  if (!peerKey || peerKey === "unknown") return null;
  const row = readStore(accountId).peers[peerKey];
  return row ?? null;
}

export function isIntentionalVoiceMute(
  accountId: string | null | undefined,
  peerKey: string,
): boolean {
  return readStoredVoicePeerMediaPrefs(accountId, peerKey)?.voiceMuted === true;
}

/** Merge a peer prefs patch. Pass null fields to clear optional flags. */
export function patchStoredVoicePeerMediaPrefs(
  accountId: string | null | undefined,
  peerKey: string,
  patch: {
    voiceMuted?: boolean;
    volumePercent?: number | null;
    muteVideo?: boolean;
    muteScreen?: boolean;
  },
): void {
  if (!peerKey || peerKey === "unknown") return;
  const store = readStore(accountId);
  const prev = store.peers[peerKey] ?? { voiceMuted: false };
  const next: StoredVoicePeerMediaPrefs = { ...prev };

  if (patch.voiceMuted != null) next.voiceMuted = patch.voiceMuted;
  if (patch.volumePercent === null) {
    delete next.volumePercent;
  } else if (
    typeof patch.volumePercent === "number" &&
    Number.isFinite(patch.volumePercent) &&
    patch.volumePercent > 0
  ) {
    next.volumePercent = Math.min(200, Math.max(1, Math.round(patch.volumePercent)));
  }
  if (patch.muteVideo != null) {
    if (patch.muteVideo) next.muteVideo = true;
    else delete next.muteVideo;
  }
  if (patch.muteScreen != null) {
    if (patch.muteScreen) next.muteScreen = true;
    else delete next.muteScreen;
  }

  if (
    !next.voiceMuted &&
    next.muteVideo !== true &&
    next.muteScreen !== true &&
    next.volumePercent == null
  ) {
    delete store.peers[peerKey];
  } else {
    store.peers[peerKey] = next;
  }
  writeStore(accountId, store);
}

/** Map stored prefs into the in-memory participantMediaPrefs shape. */
export function storedPrefsToSessionPrefs(
  stored: StoredVoicePeerMediaPrefs | null,
  fallbackVolumePercent: number,
): { volumePercent: number; muteVideo: boolean; muteScreen: boolean } | null {
  if (!stored) return null;
  const volumePercent = stored.voiceMuted
    ? 0
    : typeof stored.volumePercent === "number" && stored.volumePercent > 0
      ? stored.volumePercent
      : fallbackVolumePercent > 0
        ? fallbackVolumePercent
        : 100;
  return {
    volumePercent,
    muteVideo: stored.muteVideo === true,
    muteScreen: stored.muteScreen === true,
  };
}

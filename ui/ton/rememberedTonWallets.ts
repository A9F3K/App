export type RememberedTonWallet = {
  address: string;
  /** Friendly bounceable form when known. */
  friendlyAddress?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  lastConnectedAt: number;
};

const STORAGE_KEY = "hsp.tonconnect.rememberedWallets.v1";
const MAX_WALLETS = 8;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase();
}

export function readRememberedTonWallets(): RememberedTonWallet[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is RememberedTonWallet => {
        return (
          row != null &&
          typeof row === "object" &&
          typeof (row as RememberedTonWallet).address === "string" &&
          (row as RememberedTonWallet).address.trim().length > 0
        );
      })
      .map((row) => ({
        address: row.address.trim(),
        friendlyAddress: row.friendlyAddress?.trim() || null,
        name: row.name?.trim() || null,
        imageUrl: row.imageUrl?.trim() || null,
        lastConnectedAt:
          typeof row.lastConnectedAt === "number" && Number.isFinite(row.lastConnectedAt)
            ? row.lastConnectedAt
            : 0,
      }))
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
      .slice(0, MAX_WALLETS);
  } catch {
    return [];
  }
}

function writeRememberedTonWallets(rows: RememberedTonWallet[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_WALLETS)));
  } catch {
    // ignore quota / private mode
  }
}

/** Upsert the active connection into the remembered list (most-recent first). */
export function rememberTonWallet(entry: {
  address: string;
  friendlyAddress?: string | null;
  name?: string | null;
  imageUrl?: string | null;
}): RememberedTonWallet[] {
  const address = entry.address.trim();
  if (!address) return readRememberedTonWallets();
  const key = normalizeAddressKey(address);
  const prev = readRememberedTonWallets().filter(
    (row) => normalizeAddressKey(row.address) !== key,
  );
  const next: RememberedTonWallet[] = [
    {
      address,
      friendlyAddress: entry.friendlyAddress?.trim() || null,
      name: entry.name?.trim() || null,
      imageUrl: entry.imageUrl?.trim() || null,
      lastConnectedAt: Date.now(),
    },
    ...prev,
  ].slice(0, MAX_WALLETS);
  writeRememberedTonWallets(next);
  return next;
}

export function removeRememberedTonWallet(address: string): RememberedTonWallet[] {
  const key = normalizeAddressKey(address);
  const next = readRememberedTonWallets().filter(
    (row) => normalizeAddressKey(row.address) !== key,
  );
  writeRememberedTonWallets(next);
  return next;
}

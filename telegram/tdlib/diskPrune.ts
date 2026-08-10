import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getTdlibDbRoot, getTdlibStorageMode } from "./env.js";
import { logGateway } from "./gatewayLog.js";

const CRITICAL_FREE_BYTES = 400 * 1024 * 1024;
const AGGRESSIVE_FREE_BYTES = 200 * 1024 * 1024;

function dirSizeBytes(target: string): number {
  if (!fs.existsSync(target)) return 0;
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // Skip unreadable entries while pruning.
      }
    }
  }
  return total;
}

function rmTreeContents(target: string): number {
  if (!fs.existsSync(target)) return 0;
  const before = dirSizeBytes(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    logGateway("disk_prune_rm_failed", {
      target,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    // Caller may recreate; ignore.
  }
  return before;
}

function isAuthBinlogName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("binlog") || lower.endsWith(".binlog");
}

/**
 * Drop disposable TDLib local mirrors (SQLite chat/message DB + media files).
 * Keeps auth binlog so users stay logged in. Safe only when TDLib is not running.
 */
export function purgeTdlibLocalMirrorsForSlimMode(): number {
  if (getTdlibStorageMode() !== "slim") return 0;
  const root = getTdlibDbRoot();
  if (!fs.existsSync(root)) return 0;

  let freed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userDir = path.join(root, entry.name);
    freed += rmTreeContents(path.join(userDir, "files"));
    freed += rmTreeContents(path.join(userDir, "temp"));

    const dbDir = path.join(userDir, "db");
    if (!fs.existsSync(dbDir)) continue;
    for (const file of fs.readdirSync(dbDir, { withFileTypes: true })) {
      if (!file.isFile() && !file.isSymbolicLink()) continue;
      if (isAuthBinlogName(file.name)) continue;
      const full = path.join(dbDir, file.name);
      try {
        const size = fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        freed += size;
      } catch (err) {
        logGateway("disk_prune_sqlite_rm_failed", {
          telegramUsername: entry.name,
          file: file.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logGateway("disk_prune_slim_mirrors", {
    root,
    freedBytes: freed,
    note: "Removed local chat/message SQLite + files; auth binlog kept. Telegram is source of truth.",
  });
  return freed;
}

function readDfFreeBytes(mountHint: string): number | null {
  try {
    const out = execFileSync("df", ["-Bk", mountHint], { encoding: "utf8" });
    const lines = out.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[lines.length - 1]!.trim().split(/\s+/);
    // Filesystem Size Used Avail Use% Mounted
    const avail = cols[3] || "";
    const match = /^(\d+)k?$/i.exec(avail);
    if (!match) return null;
    return Number.parseInt(match[1]!, 10) * 1024;
  } catch {
    return null;
  }
}

type UserDiskRow = {
  username: string;
  userDir: string;
  filesBytes: number;
  dbBytes: number;
  totalBytes: number;
};

function listUserDiskRows(root: string): UserDiskRow[] {
  if (!fs.existsSync(root)) return [];
  const rows: UserDiskRow[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userDir = path.join(root, entry.name);
    const filesBytes = dirSizeBytes(path.join(userDir, "files"));
    const dbBytes = dirSizeBytes(path.join(userDir, "db"));
    rows.push({
      username: entry.name,
      userDir,
      filesBytes,
      dbBytes,
      totalBytes: dirSizeBytes(userDir),
    });
  }
  rows.sort((a, b) => b.totalBytes - a.totalBytes);
  return rows;
}

/**
 * Free Railway volume space before TDLib session restore.
 * In slim mode, first drop SQLite chat mirrors (auth binlog kept).
 * When still critically full, drop non-kept session dirs.
 */
export function pruneTdlibDiskBeforeRestore(): void {
  const slimFreed = purgeTdlibLocalMirrorsForSlimMode();

  const mode = (process.env.TDLIB_DISK_PRUNE || "auto").trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") {
    logGateway("disk_prune_skipped", { mode, slimFreedBytes: slimFreed });
    return;
  }

  const root = getTdlibDbRoot();
  const freeBefore = readDfFreeBytes(root) ?? readDfFreeBytes("/data");
  const rows = listUserDiskRows(root);
  const totalBefore = rows.reduce((sum, row) => sum + row.totalBytes, 0);

  logGateway("disk_prune_start", {
    mode,
    root,
    freeBeforeBytes: freeBefore,
    userCount: rows.length,
    totalBeforeBytes: totalBefore,
    slimFreedBytes: slimFreed,
    topUsers: rows.slice(0, 8).map((row) => ({
      username: row.username,
      totalBytes: row.totalBytes,
      filesBytes: row.filesBytes,
      dbBytes: row.dbBytes,
    })),
  });

  const force = mode === "always" || mode === "aggressive" || mode === "1" || mode === "true";
  const needPrune =
    force ||
    freeBefore === null ||
    freeBefore < CRITICAL_FREE_BYTES ||
    totalBefore > 4.2 * 1024 * 1024 * 1024;

  if (!needPrune) {
    logGateway("disk_prune_not_needed", {
      freeBeforeBytes: freeBefore,
      totalBeforeBytes: totalBefore,
      slimFreedBytes: slimFreed,
    });
    return;
  }

  let freedFilesBytes = 0;
  for (const row of rows) {
    freedFilesBytes += rmTreeContents(path.join(row.userDir, "files"));
    freedFilesBytes += rmTreeContents(path.join(row.userDir, "temp"));
  }

  let freeAfterFiles = readDfFreeBytes(root) ?? readDfFreeBytes("/data");
  let freedSessionBytes = 0;

  const stillCritical =
    mode === "aggressive" ||
    freeAfterFiles === null ||
    freeAfterFiles < AGGRESSIVE_FREE_BYTES;

  if (stillCritical) {
    const keepRaw = (process.env.TDLIB_DISK_PRUNE_KEEP || "").trim();
    const keepSet = new Set(
      keepRaw
        ? keepRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [],
    );
    const afterTiny = listUserDiskRows(root);
    // Prefer an explicit keep-list; else keep the largest session (usually the active user).
    if (keepSet.size === 0 && afterTiny.length > 0) {
      keepSet.add(afterTiny[0]!.username.toLowerCase());
    }

    const dropCandidates = [
      // Tiny / incomplete first.
      ...afterTiny.filter((row) => row.dbBytes < 8 * 1024 * 1024),
      // Then every non-kept session (e.g. secondary email_* DB eating ~0.7GB).
      ...afterTiny.filter((row) => row.dbBytes >= 8 * 1024 * 1024),
    ].filter((row, index, all) => {
      if (keepSet.has(row.username.toLowerCase())) return false;
      return all.findIndex((other) => other.username === row.username) === index;
    });

    for (const row of dropCandidates) {
      const freeNow = readDfFreeBytes(root) ?? readDfFreeBytes("/data");
      if (freeNow !== null && freeNow >= CRITICAL_FREE_BYTES) break;
      const size = row.totalBytes;
      try {
        fs.rmSync(row.userDir, { recursive: true, force: true });
        freedSessionBytes += size;
        logGateway("disk_prune_drop_session", {
          telegramUsername: row.username,
          bytes: size,
          dbBytes: row.dbBytes,
          keep: [...keepSet],
        });
      } catch (err) {
        logGateway("disk_prune_drop_session_failed", {
          telegramUsername: row.username,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const freeAfter = readDfFreeBytes(root) ?? readDfFreeBytes("/data");
  logGateway("disk_prune_done", {
    freedFilesBytes,
    freedSessionBytes,
    slimFreedBytes: slimFreed,
    freeBeforeBytes: freeBefore,
    freeAfterFilesBytes: freeAfterFiles,
    freeAfterBytes: freeAfter,
  });
}

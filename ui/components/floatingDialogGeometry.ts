import { Platform } from "react-native";

export type FloatingDialogEdge = "n" | "s" | "e" | "w";
export type FloatingDialogResizeHandle =
  | FloatingDialogEdge
  | "ne"
  | "nw"
  | "se"
  | "sw";

export type FloatingDialogSize = { width: number; height: number };
export type FloatingDialogOffset = { x: number; y: number };

export const FLOATING_DIALOG_HANDLES: FloatingDialogResizeHandle[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

export function edgesForFloatingDialogHandle(
  handle: FloatingDialogResizeHandle,
): FloatingDialogEdge[] {
  if (handle === "n" || handle === "s" || handle === "e" || handle === "w") return [handle];
  if (handle === "ne") return ["n", "e"];
  if (handle === "nw") return ["n", "w"];
  if (handle === "se") return ["s", "e"];
  return ["s", "w"];
}

export function cursorForFloatingDialogHandle(handle: FloatingDialogResizeHandle): string {
  switch (handle) {
    case "n":
    case "s":
      return "row-resize";
    case "e":
    case "w":
      return "col-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "nwse-resize";
  }
}

export function clampFloatingDialogSize(
  size: FloatingDialogSize,
  min: FloatingDialogSize,
  max: FloatingDialogSize,
): FloatingDialogSize {
  return {
    width: Math.min(max.width, Math.max(min.width, Math.round(size.width))),
    height: Math.min(max.height, Math.max(min.height, Math.round(size.height))),
  };
}

/** Largest size that still fits the viewport with side insets. */
export function floatingDialogViewportMax(
  windowWidth: number,
  windowHeight: number,
  insetPx = 15,
): FloatingDialogSize {
  return {
    width: Math.max(280, Math.floor(windowWidth - 2 * insetPx)),
    height: Math.max(220, Math.floor(windowHeight - 2 * insetPx)),
  };
}

export type FloatingDialogSizeKind = "profile" | "profileList" | "modal" | "picker";

/**
 * Reasonable first-open size from viewport + dialog role.
 * Always clamped to the screen; callers may still enable fitContentHeight.
 */
export function resolveFloatingDialogDefaultSize(
  windowWidth: number,
  windowHeight: number,
  kind: FloatingDialogSizeKind,
): FloatingDialogSize {
  const max = floatingDialogViewportMax(windowWidth, windowHeight);
  const prefer = (width: number, height: number) =>
    clampFloatingDialogSize({ width, height }, { width: 280, height: 220 }, max);

  switch (kind) {
    case "profile":
      // Width-first guess; fitContentHeight shrinks height to the sheet body.
      return prefer(
        Math.min(420, Math.max(360, Math.round(windowWidth * 0.34))),
        Math.min(520, Math.max(280, Math.round(windowHeight * 0.55))),
      );
    case "profileList":
      // Media / playlist: more vertical room for scrollable grids.
      return prefer(
        Math.min(440, Math.max(360, Math.round(windowWidth * 0.36))),
        Math.min(720, Math.max(540, Math.round(windowHeight * 0.84))),
      );
    case "picker":
      return prefer(
        Math.min(400, Math.max(340, Math.round(windowWidth * 0.34))),
        Math.min(560, Math.max(420, Math.round(windowHeight * 0.65))),
      );
    case "modal":
    default:
      return prefer(
        Math.min(420, Math.max(340, Math.round(windowWidth * 0.32))),
        Math.min(560, Math.max(400, Math.round(windowHeight * 0.62))),
      );
  }
}

/** Keep at least `minVisible` px of the sheet on-screen (center-anchored + offset). */
export function clampFloatingDialogOffset(
  offset: FloatingDialogOffset,
  size: FloatingDialogSize,
  winW: number,
  winH: number,
  minVisible = 48,
): FloatingDialogOffset {
  const centerX = winW / 2;
  const centerY = winH / 2;
  let x = Math.round(offset.x);
  let y = Math.round(offset.y);
  const left = centerX - size.width / 2 + x;
  const top = centerY - size.height / 2 + y;
  if (left + size.width < minVisible) x += minVisible - (left + size.width);
  if (left > winW - minVisible) x -= left - (winW - minVisible);
  if (top + size.height < minVisible) y += minVisible - (top + size.height);
  if (top > winH - minVisible) y -= top - (winH - minVisible);
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Resize from a pointer delta while pinning the opposite edge(s).
 * Sheet is center-anchored + offset, so west/north growth must shift offset.
 */
export function applyIndependentEdgeResize(args: {
  handle: FloatingDialogResizeHandle;
  startSize: FloatingDialogSize;
  startOffset: FloatingDialogOffset;
  dx: number;
  dy: number;
  clampSize: (size: FloatingDialogSize) => FloatingDialogSize;
}): { size: FloatingDialogSize; offset: FloatingDialogOffset } {
  const edges = edgesForFloatingDialogHandle(args.handle);
  let nextWidth = args.startSize.width;
  let nextHeight = args.startSize.height;
  if (edges.includes("e")) nextWidth = args.startSize.width + args.dx;
  if (edges.includes("w")) nextWidth = args.startSize.width - args.dx;
  if (edges.includes("s")) nextHeight = args.startSize.height + args.dy;
  if (edges.includes("n")) nextHeight = args.startSize.height - args.dy;

  const size = args.clampSize({ width: nextWidth, height: nextHeight });
  const dW = size.width - args.startSize.width;
  const dH = size.height - args.startSize.height;

  let x = args.startOffset.x;
  let y = args.startOffset.y;
  // Center-anchored: growing width alone moves both sides by dW/2.
  // West resize should pin the east edge → shift center left by full dW when growing west.
  if (edges.includes("w") && !edges.includes("e")) {
    x = args.startOffset.x - dW / 2;
  } else if (edges.includes("e") && !edges.includes("w")) {
    x = args.startOffset.x + dW / 2;
  }
  if (edges.includes("n") && !edges.includes("s")) {
    y = args.startOffset.y - dH / 2;
  } else if (edges.includes("s") && !edges.includes("n")) {
    y = args.startOffset.y + dH / 2;
  }

  return { size, offset: { x: Math.round(x), y: Math.round(y) } };
}

export function readFloatingDialogStoredSize(key: string): FloatingDialogSize | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

export function writeFloatingDialogStoredSize(key: string, size: FloatingDialogSize): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(size));
  } catch {
    // ignore quota / private mode
  }
}

export function readFloatingDialogStoredOffset(key: string): FloatingDialogOffset | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  } catch {
    return null;
  }
}

export function writeFloatingDialogStoredOffset(
  key: string,
  offset: FloatingDialogOffset,
): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(offset));
  } catch {
    // ignore
  }
}

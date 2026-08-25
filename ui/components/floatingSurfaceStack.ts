/**
 * Shared stacking order for floating UI (dialogs, side menu).
 * Click / open raises that surface above siblings — Telegram Desktop / OS window behavior.
 */

export const FLOATING_SURFACE_BASE_Z = 10050;
const FLOATING_SURFACE_Z_STEP = 10;

let topZ = FLOATING_SURFACE_BASE_Z;
const zById = new Map<string, number>();
let seq = 0;

export function allocateFloatingSurfaceId(prefix = "float"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function peekFloatingSurfaceZ(id: string): number {
  return zById.get(id) ?? FLOATING_SURFACE_BASE_Z;
}

/** Register a surface; returns its initial z-index (already on top). */
export function registerFloatingSurface(id: string, minZ = FLOATING_SURFACE_BASE_Z): number {
  topZ = Math.max(topZ, minZ) + FLOATING_SURFACE_Z_STEP;
  zById.set(id, topZ);
  return topZ;
}

export function unregisterFloatingSurface(id: string): void {
  zById.delete(id);
}

/** Raise this surface above all other registered floating surfaces. */
export function bringFloatingSurfaceToFront(id: string, minZ = FLOATING_SURFACE_BASE_Z): number {
  if (!zById.has(id)) {
    return registerFloatingSurface(id, minZ);
  }
  const current = zById.get(id) ?? FLOATING_SURFACE_BASE_Z;
  if (current >= topZ && current >= minZ) {
    return current;
  }
  topZ = Math.max(topZ, minZ, current) + FLOATING_SURFACE_Z_STEP;
  zById.set(id, topZ);
  return topZ;
}

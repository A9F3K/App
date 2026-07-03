/** Revoke blob URLs after the current frame so <video>/<img> can detach first. */
export function deferRevokeObjectUrl(url: string | null | undefined): void {
  if (!url) return;
  queueMicrotask(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  });
}

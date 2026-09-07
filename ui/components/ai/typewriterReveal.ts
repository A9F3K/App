/**
 * Reveal `fullText` code-point by code-point (symbol-by-symbol).
 * Returns when complete or when `signal` aborts.
 */
export function typewriterReveal(
  fullText: string,
  onPartial: (partial: string) => void,
  options?: {
    signal?: AbortSignal;
    /** Target reveal speed; default ~90 code points / second. */
    charsPerSec?: number;
  },
): Promise<void> {
  const chars = Array.from(fullText);
  if (chars.length === 0) {
    onPartial(fullText);
    return Promise.resolve();
  }

  const signal = options?.signal;
  const charsPerSec = Math.max(20, options?.charsPerSec ?? 90);

  return new Promise((resolve) => {
    if (signal?.aborted) {
      onPartial(fullText);
      resolve();
      return;
    }

    const startedAt = performance.now();
    let shown = 0;
    let raf = 0;

    const finish = (partial: string) => {
      if (raf) cancelAnimationFrame(raf);
      onPartial(partial);
      resolve();
    };

    const onAbort = () => finish(fullText);
    signal?.addEventListener("abort", onAbort, { once: true });

    const tick = () => {
      if (signal?.aborted) {
        finish(fullText);
        return;
      }
      const elapsedSec = (performance.now() - startedAt) / 1000;
      const target = Math.min(
        chars.length,
        Math.max(shown + 1, Math.floor(elapsedSec * charsPerSec)),
      );
      if (target !== shown) {
        shown = target;
        onPartial(chars.slice(0, shown).join(""));
      }
      if (shown >= chars.length) {
        signal?.removeEventListener("abort", onAbort);
        finish(fullText);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    onPartial("");
    raf = requestAnimationFrame(tick);
  });
}

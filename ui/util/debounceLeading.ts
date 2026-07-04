/** Leading-edge debounce — fires immediately, then ignores until waitMs elapses. */
export function debounceLeading<T extends (...args: never[]) => void>(
  fn: T,
  waitMs: number,
): (...args: Parameters<T>) => void {
  let locked = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (locked) return;
    locked = true;
    fn(...args);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      locked = false;
      timer = null;
    }, waitMs);
  };
}

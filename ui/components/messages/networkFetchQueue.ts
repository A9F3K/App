export type NetworkFetchPriority = "critical" | "high" | "normal";

/** Photos + avatars + emoji share this pool; keep enough slots for scroll fill. */
const MAX_CONCURRENT = 8;
let inFlight = 0;
const criticalWaiters: Array<() => void> = [];
const highWaiters: Array<() => void> = [];
const normalWaiters: Array<() => void> = [];

function dequeue(): (() => void) | undefined {
  return criticalWaiters.shift() ?? highWaiters.shift() ?? normalWaiters.shift();
}

function drainWaiters(): void {
  while (inFlight < MAX_CONCURRENT) {
    const next = dequeue();
    if (!next) break;
    next();
  }
}

/**
 * On chat switch, demote non-critical waiters so the newly painted chat can jump
 * ahead of leftover media/avatar/emoji jobs from the previous chat.
 * Already in-flight HTTP requests keep running.
 */
export function demoteQueuedNetworkFetches(): void {
  if (highWaiters.length === 0) return;
  normalWaiters.push(...highWaiters.splice(0, highWaiters.length));
}

/** Limit parallel browser fetches; critical > high > normal. */
export function runQueuedNetworkFetch<T>(
  fn: () => Promise<T>,
  options?: { priority?: NetworkFetchPriority },
): Promise<T> {
  const priority = options?.priority ?? "normal";
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      void fn()
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          drainWaiters();
        });
    };
    if (inFlight < MAX_CONCURRENT) {
      run();
      return;
    }
    if (priority === "critical") criticalWaiters.push(run);
    else if (priority === "high") highWaiters.push(run);
    else normalWaiters.push(run);
  });
}

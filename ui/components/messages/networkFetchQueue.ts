export type NetworkFetchPriority = "high" | "normal";

/** Photos + avatars + emoji share this pool; keep enough slots for scroll fill. */
const MAX_CONCURRENT = 8;
let inFlight = 0;
const highWaiters: Array<() => void> = [];
const normalWaiters: Array<() => void> = [];

function dequeue(): (() => void) | undefined {
  return highWaiters.shift() ?? normalWaiters.shift();
}

function drainWaiters(): void {
  while (inFlight < MAX_CONCURRENT) {
    const next = dequeue();
    if (!next) break;
    next();
  }
}

/** Limit parallel browser fetches; high-priority jobs run before background list work. */
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
    if (inFlight < MAX_CONCURRENT) run();
    else if (priority === "high") highWaiters.push(run);
    else normalWaiters.push(run);
  });
}

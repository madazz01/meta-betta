// One hero per Brain: only one turn runs at a time across all tabs. The lock
// lives in the extension host (one module instance), so every tab's MuseHost
// shares it. Non-reentrant: a holder asking twice still loses the second
// time, and only the holder can release.

let holder: string | undefined;

type LockListener = (current: string | undefined) => void;
const listeners = new Set<LockListener>();

/**
 * Hear about holder changes (the Sessions view's spinner). Returns an
 * unsubscribe. A throwing listener never breaks the lock or the others.
 */
export function subscribeLock(listener: LockListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(holder);
    } catch {
      // One bad listener stays its own problem.
    }
  }
}

/** Take the lock for a tab; false when another turn is already running. */
export function acquire(candidate: string): boolean {
  if (holder !== undefined) {
    return false;
  }
  holder = candidate;
  notify();
  return true;
}

/** Give the lock back; anyone else's release is ignored. */
export function release(candidate: string): void {
  if (holder === candidate) {
    holder = undefined;
    notify();
  }
}

/** The tab holding the lock, if any. */
export function current(): string | undefined {
  return holder;
}

/** A send that lost the lock race after its controller checked. */
export class TurnBusyError extends Error {
  public constructor() {
    super("Muse is still working — try again when it's done.");
  }
}

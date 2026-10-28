// Share one in-flight call: concurrent callers await the same promise.
// Failures are not cached; the next call after a settle retries.

export function singleFlight<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let pending: Promise<R> | undefined;
  return (...args) => {
    pending ??= fn(...args).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

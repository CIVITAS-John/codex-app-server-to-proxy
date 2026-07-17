/** Options controlling a derived cancellation deadline. */
interface DeadlineOptions {
  milliseconds: number;
  timeoutReason: unknown;
  abortReason?: (signal: AbortSignal) => unknown;
}

/** Registers one abort listener and returns an idempotent disposer. */
export function listenForAbort(
  signal: AbortSignal | undefined,
  listener: (signal: AbortSignal) => void,
): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    listener(signal);
    return () => undefined;
  }

  let disposed = false;
  const onAbort = (): void => {
    if (disposed) return;
    try {
      listener(signal);
    } finally {
      dispose();
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", onAbort);
  };
  return dispose;
}

/** Resolves after a delay or rejects with the signal's exact abort reason. */
export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    const disposeAbort = listenForAbort(signal, (abortedSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposeAbort();
      reject(abortedSignal.reason);
    });

    function done(): void {
      if (settled) return;
      settled = true;
      disposeAbort();
      resolve();
    }
  });
}

/** Runs work with a derived signal that aborts at a deadline or with its parent. */
export async function withDeadline<T>(
  parentSignal: AbortSignal | undefined,
  options: DeadlineOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const disposeParent = listenForAbort(parentSignal, (abortedSignal) => {
    controller.abort(
      options.abortReason === undefined
        ? abortedSignal.reason
        : options.abortReason(abortedSignal),
    );
  });
  const timer = setTimeout(
    () => controller.abort(options.timeoutReason),
    options.milliseconds,
  );
  timer.unref();

  try {
    // Await the operation itself: aborting the derived signal does not settle an
    // operation that intentionally ignores cancellation.
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    disposeParent();
  }
}

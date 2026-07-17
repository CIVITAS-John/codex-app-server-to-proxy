import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  abortableDelay,
  listenForAbort,
  withDeadline,
} from "../../src/core/abort.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("listenForAbort narrows the signal and disposes idempotently", () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const seen: AbortSignal[] = [];
  const dispose = listenForAbort(controller.signal, (signal) =>
    seen.push(signal),
  );

  dispose();
  dispose();
  controller.abort(new Error("too late"));

  assert.deepEqual(seen, []);
  assert.equal(remove.mock.calls.length, 1);
  assert.doesNotThrow(() => listenForAbort(undefined, () => undefined)());
});

test("listenForAbort invokes synchronously for an already-aborted signal", () => {
  const reason = new Error("already stopped");
  const controller = new AbortController();
  controller.abort(reason);
  let synchronous = false;

  const dispose = listenForAbort(controller.signal, (signal) => {
    assert.equal(signal, controller.signal);
    assert.equal(signal.reason, reason);
    synchronous = true;
  });

  assert.equal(synchronous, true);
  assert.doesNotThrow(dispose);
  assert.doesNotThrow(dispose);
});

test("listenForAbort invokes an active listener only once", () => {
  const reason = new Error("stopped");
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const seen: AbortSignal[] = [];
  const dispose = listenForAbort(controller.signal, (signal) =>
    seen.push(signal),
  );

  controller.abort(reason);
  dispose();
  dispose();

  assert.deepEqual(seen, [controller.signal]);
  assert.equal(seen[0]!.reason, reason);
  assert.equal(remove.mock.calls.length, 1);
});

test("abortableDelay resolves and removes its abort listener", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const delayed = abortableDelay(50, controller.signal);

  await vi.advanceTimersByTimeAsync(50);
  await delayed;

  assert.equal(remove.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("abortableDelay supports an absent signal", async () => {
  vi.useFakeTimers();
  const delayed = abortableDelay(50);

  await vi.advanceTimersByTimeAsync(50);

  await delayed;
  assert.equal(vi.getTimerCount(), 0);
});

test("abortableDelay rejects with the exact reason and cleans up", async () => {
  vi.useFakeTimers();
  const reason = { source: "parent" };
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const delayed = abortableDelay(50, controller.signal);

  controller.abort(reason);

  await assert.rejects(delayed, (error: unknown) => error === reason);
  assert.equal(remove.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);

  const alreadyAborted = abortableDelay(50, controller.signal);
  await assert.rejects(alreadyAborted, (error: unknown) => error === reason);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline clears its deadline and parent listener on resolution", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const remove = vi.spyOn(parent.signal, "removeEventListener");
  const value = await withDeadline(
    parent.signal,
    { milliseconds: 50, timeoutReason: new Error("timeout") },
    async (signal) => {
      assert.equal(signal.aborted, false);
      return 42;
    },
  );

  assert.equal(value, 42);
  assert.equal(remove.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline cleans up when work rejects", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const remove = vi.spyOn(parent.signal, "removeEventListener");
  const failure = new Error("operation failed");
  const operation = withDeadline(
    parent.signal,
    { milliseconds: 50, timeoutReason: new Error("timeout") },
    async () => {
      throw failure;
    },
  );

  await assert.rejects(operation, (error: unknown) => error === failure);
  assert.equal(remove.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline aborts its derived signal with the exact timeout reason", async () => {
  vi.useFakeTimers();
  const timeoutReason = { source: "deadline" };
  const operation = withDeadline(
    undefined,
    { milliseconds: 50, timeoutReason },
    async (signal) =>
      await new Promise<unknown>((resolve) => {
        signal.addEventListener("abort", () => resolve(signal.reason), {
          once: true,
        });
      }),
  );

  await vi.advanceTimersByTimeAsync(50);

  assert.equal(await operation, timeoutReason);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline gives parent cancellation precedence when it happens first", async () => {
  vi.useFakeTimers();
  const parentReason = new Error("parent stopped");
  const timeoutReason = new Error("timeout");
  const parent = new AbortController();
  const operation = withDeadline(
    parent.signal,
    { milliseconds: 50, timeoutReason },
    async (signal) =>
      await new Promise<unknown>((resolve) => {
        signal.addEventListener("abort", () => resolve(signal.reason), {
          once: true,
        });
      }),
  );

  parent.abort(parentReason);
  await vi.advanceTimersByTimeAsync(50);

  assert.equal(await operation, parentReason);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline preserves a timeout when it aborts before the parent", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const timeoutReason = new Error("timeout first");
  let observedSignal!: AbortSignal;
  const operation = withDeadline(
    parent.signal,
    { milliseconds: 50, timeoutReason },
    async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return signal.reason;
    },
  );

  await vi.advanceTimersByTimeAsync(50);
  parent.abort(new Error("parent too late"));

  assert.equal(await operation, timeoutReason);
  assert.equal(observedSignal.reason, timeoutReason);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline forwards an already-aborted parent before running", async () => {
  vi.useFakeTimers();
  const parentReason = { source: "already-aborted" };
  const parent = new AbortController();
  parent.abort(parentReason);

  const seen = await withDeadline(
    parent.signal,
    {
      milliseconds: 0,
      timeoutReason: new Error("timeout"),
    },
    async (signal) => ({ aborted: signal.aborted, reason: signal.reason }),
  );

  assert.deepEqual(seen, { aborted: true, reason: parentReason });
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline uses the configured parent-reason mapper", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  parent.abort("raw reason");
  const mappedReason = new Error("mapped parent cancellation");

  const reason = await withDeadline(
    parent.signal,
    {
      milliseconds: 50,
      timeoutReason: new Error("timeout"),
      abortReason: (signal) => {
        assert.equal(signal, parent.signal);
        assert.equal(signal.reason, "raw reason");
        return mappedReason;
      },
    },
    async (signal) => signal.reason,
  );

  assert.equal(reason, mappedReason);
  assert.equal(vi.getTimerCount(), 0);
});

test("withDeadline does not race work that ignores abort", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const operation = withDeadline(
    undefined,
    { milliseconds: 10, timeoutReason: new Error("timeout") },
    async () =>
      await new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );

  await vi.advanceTimersByTimeAsync(10);
  let settled = false;
  void operation.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  finish("completed anyway");
  assert.equal(await operation, "completed anyway");
  assert.equal(vi.getTimerCount(), 0);
});

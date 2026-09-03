/** Exact provider-response counts observed through app-server raw events. */
export interface ProviderCallStats {
  parent: number;
  child: number;
  total: number;
}

/** Root turn that can be interrupted when the live cost ceiling is reached. */
export interface ActiveRootTurn {
  threadId: string;
  turnId: string;
}

/** Sends the app-server interrupt that enforces the live provider-call ceiling. */
export type RootTurnInterrupter = (turn: ActiveRootTurn) => Promise<void>;

/**
 * Tracks authoritative upstream Responses completions for one restartable live
 * run. The instance outlives individual app-server processes so replayed raw
 * events and restart continuations cannot reset or double-count the budget.
 */
export class ProviderCallBudget {
  readonly #seen = new Set<string>();
  readonly #rootThreads = new Set<string>();
  readonly #childThreads = new Set<string>();
  readonly #maximum: number;
  #parent = 0;
  #child = 0;
  #activeRootTurn: ActiveRootTurn | undefined;
  #interruptRequested = false;
  #interruptPromise: Promise<void> | undefined;
  #failure: Error | undefined;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error("Provider-call maximum must be a positive integer.");
    this.#maximum = maximum;
  }

  /** Marks a proxy-created or resumed thread as a parent/root thread. */
  registerRootThread(threadId: string): void {
    if (threadId !== "") this.#rootThreads.add(threadId);
  }

  /** Records the newest active parent turn that the ceiling may interrupt. */
  activateRootTurn(threadId: string, turnId: string): void {
    this.registerRootThread(threadId);
    this.#activeRootTurn = { threadId, turnId };
  }

  /** Releases a root turn when its owning app-server generation is closed. */
  releaseRootTurn(turn: ActiveRootTurn): void {
    if (
      this.#activeRootTurn?.threadId === turn.threadId &&
      this.#activeRootTurn.turnId === turn.turnId
    )
      this.#activeRootTurn = undefined;
  }

  /**
   * Consumes one app-server notification. Only raw completion boundaries spend
   * budget; terminal turn notifications clear stale interrupt targets.
   */
  observe(
    method: string,
    params: unknown,
    interrupt: RootTurnInterrupter,
  ): void {
    const value = objectRecord(params);
    if (method === "turn/completed") {
      const turn = objectRecord(value?.turn);
      const activeRootTurn = this.#activeRootTurn;
      if (
        activeRootTurn &&
        value?.threadId === activeRootTurn.threadId &&
        turn?.id === activeRootTurn.turnId
      )
        this.#activeRootTurn = undefined;
      return;
    }
    if (method !== "rawResponse/completed") return;

    const threadId = value?.threadId;
    const responseId = value?.responseId;
    const turnId = value?.turnId;
    if (typeof threadId !== "string" || typeof responseId !== "string") {
      this.#fail(
        "Live provider-call accounting received rawResponse/completed without string threadId and responseId fields.",
      );
      return;
    }
    const key = JSON.stringify([threadId, responseId]);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    if (this.#rootThreads.has(threadId)) {
      this.#parent += 1;
      // App-server may flush the turn/start response and its first raw event in
      // one read. The raw event itself then supplies the safe interrupt target
      // before the request promise continuation records it.
      if (!this.#activeRootTurn && typeof turnId === "string")
        this.#activeRootTurn = { threadId, turnId };
    } else {
      this.#child += 1;
      this.#childThreads.add(threadId);
    }

    const total = this.#parent + this.#child;
    if (total > this.#maximum) {
      this.#fail(
        `Live provider-call ceiling of ${this.#maximum} was exceeded by a newly observed completion.`,
      );
      return;
    }
    if (total === this.#maximum) this.#interruptAtCeiling(interrupt);
  }

  /** Returns an immutable count snapshot, failing after any budget violation. */
  stats(): ProviderCallStats {
    this.assertHealthy();
    return {
      parent: this.#parent,
      child: this.#child,
      total: this.#parent + this.#child,
    };
  }

  /** Throws the first accounting or ceiling failure observed by this run. */
  assertHealthy(): void {
    if (this.#failure) throw this.#failure;
  }

  /** Waits for a ceiling interrupt and surfaces its asynchronous failure. */
  async settle(): Promise<void> {
    await this.#interruptPromise;
    this.assertHealthy();
  }

  /** Requires proof that child-thread raw completions reached this connection. */
  assertChildCallsObserved(): void {
    this.assertHealthy();
    if (this.#child === 0)
      throw new Error(
        "Live spawned-agent contract observed no child-thread rawResponse/completed events; child provider calls cannot be accounted safely.",
      );
  }

  /** Requires a completion from the exact child named by spawnAgent output. */
  assertChildThreadCallsObserved(childThreadId: string): void {
    this.assertHealthy();
    if (!this.#childThreads.has(childThreadId))
      throw new Error(
        `Live spawned-agent contract observed no rawResponse/completed event for expected child thread ${JSON.stringify(childThreadId)}.`,
      );
  }

  /** Interrupts the active root turn once when the accepted ceiling is reached. */
  #interruptAtCeiling(interrupt: RootTurnInterrupter): void {
    if (this.#interruptRequested) return;
    const turn = this.#activeRootTurn;
    // A naturally completed request can reach the exact ceiling with no work
    // left to interrupt. The request preflight still prevents another turn.
    if (!turn) return;
    this.#interruptRequested = true;
    this.#interruptPromise = interrupt(turn).catch((error: unknown) => {
      this.#fail(
        `Live provider-call ceiling interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Retains the first failure so later diagnostics remain deterministic. */
  #fail(message: string): void {
    this.#failure ??= new Error(message);
  }
}

/** Narrows untrusted protocol data to a JSON object. */
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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
  readonly #responseOutputs = new Map<
    string,
    { finalAnswer: boolean; mayContinue: boolean }
  >();
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
    this.#responseOutputs.delete(JSON.stringify([turn.threadId, turn.turnId]));
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
    const threadId = value?.threadId;
    const turnId = value?.turnId;
    if (
      method === "rawResponseItem/completed" &&
      typeof threadId === "string" &&
      typeof turnId === "string"
    ) {
      const key = JSON.stringify([threadId, turnId]);
      const output = this.#responseOutputs.get(key) ?? {
        finalAnswer: false,
        mayContinue: false,
      };
      const item = objectRecord(value?.item);
      if (item?.type === "message") {
        if (
          item.role === "assistant" &&
          (item.phase === "final_answer" || item.phase == null) &&
          Array.isArray(item.content) &&
          item.content.some((part: unknown) => {
            const content = objectRecord(part);
            return (
              content?.type === "output_text" &&
              typeof content.text === "string" &&
              content.text.length > 0
            );
          })
        )
          output.finalAnswer = true;
      } else if (item?.type !== "reasoning") {
        // Tool calls (including unknown future kinds) can trigger another
        // provider request even if the response also contains final prose.
        output.mayContinue = true;
      }
      this.#responseOutputs.set(key, output);
      return;
    }
    if (method === "turn/completed") {
      const turn = objectRecord(value?.turn);
      this.#responseOutputs.delete(JSON.stringify([threadId, turn?.id]));
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

    const responseId = value?.responseId;
    if (typeof threadId !== "string" || typeof responseId !== "string") {
      this.#fail(
        "Live provider-call accounting received rawResponse/completed without string threadId and responseId fields.",
      );
      return;
    }
    const key = JSON.stringify([threadId, responseId]);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const outputKey = JSON.stringify([threadId, turnId]);
    const output = this.#responseOutputs.get(outputKey);
    this.#responseOutputs.delete(outputKey);
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
      this.#interruptAtCeiling(interrupt);
      return;
    }
    // A root final answer with no tools has no follow-up provider work. Let
    // turn/completed arrive naturally so the last allowed SSE ends with stop.
    // Child answers still require root work and must retain the interrupt.
    const finishingRoot =
      this.#rootThreads.has(threadId) &&
      output?.finalAnswer === true &&
      !output.mayContinue;
    if (total === this.#maximum && !finishingRoot)
      this.#interruptAtCeiling(interrupt);
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

  /** Rejects a new root turn before its RPC can spend an exhausted budget. */
  assertCanStartTurn(): void {
    this.assertHealthy();
    if (this.#parent + this.#child >= this.#maximum)
      throw new Error(
        `Live provider-call ceiling of ${this.#maximum} prevents another turn.`,
      );
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

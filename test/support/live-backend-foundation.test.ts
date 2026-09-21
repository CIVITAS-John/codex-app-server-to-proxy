import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";
import { UNRESTRICTED_POLICY_REQUIREMENTS } from "../../src/core/policy.js";
import { EventNormalizer } from "../../src/http/chat-normalize.js";
import { protocolTurn } from "./protocol-fixtures.js";
import { assertLivePolicyPrerequisites } from "./chat-backends.js";
import { ProviderCallBudget } from "./provider-call-budget.js";

/** Builds one provider completion notification payload. */
function completion(
  threadId: string,
  responseId: string,
  turnId = `turn_${threadId}`,
): Extract<ServerNotification, { method: "rawResponse/completed" }>["params"] {
  return { threadId, turnId, responseId, usage: null, usageMetadata: null };
}

test("provider-call accounting deduplicates parent and child completions and enforces its ceiling", async () => {
  const budget = new ProviderCallBudget(24);
  budget.registerRootThread("root");
  budget.activateRootTurn("root", "turn_root");
  const interrupted: Array<{ threadId: string; turnId: string }> = [];
  const interrupt = async (turn: {
    threadId: string;
    turnId: string;
  }): Promise<void> => {
    interrupted.push(turn);
  };

  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_1", "turn_root"),
    interrupt,
  );
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_1", "turn_root"),
    interrupt,
  );
  budget.observe(
    "rawResponse/completed",
    completion("child", "child_1"),
    interrupt,
  );
  for (let index = 2; index <= 22; index += 1)
    budget.observe(
      "rawResponse/completed",
      completion("child", `child_${index}`),
      interrupt,
    );

  assert.deepEqual(budget.stats(), { parent: 1, child: 22, total: 23 });
  budget.assertChildCallsObserved();
  budget.assertChildThreadCallsObserved("child");
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_2", "turn_root"),
    interrupt,
  );
  await Promise.resolve();
  assert.deepEqual(budget.stats(), { parent: 2, child: 22, total: 24 });
  assert.deepEqual(interrupted, [{ threadId: "root", turnId: "turn_root" }]);

  budget.observe(
    "rawResponse/completed",
    completion("child", "child_23"),
    interrupt,
  );
  assert.throws(
    () => budget.stats(),
    /ceiling of 24 was exceeded by a newly observed completion/u,
  );
});

test("the final permitted answer reaches stop before another turn is rejected", async () => {
  for (const phase of [undefined, "final_answer"] as const) {
    const budget = new ProviderCallBudget(2);
    const interrupted: string[] = [];
    const interrupt = async ({ turnId }: { turnId: string }): Promise<void> => {
      interrupted.push(turnId);
    };
    const observe = (notification: ServerNotification): void =>
      budget.observe(notification.method, notification.params, interrupt);
    for (const turnId of ["aggregate", "sse"]) {
      budget.assertCanStartTurn();
      budget.activateRootTurn("root", turnId);
      observe({
        method: "rawResponseItem/completed",
        params: {
          threadId: "root",
          turnId,
          item: {
            type: "message",
            role: "assistant",
            ...(phase ? { phase } : {}),
            content: [{ type: "output_text", text: "synthetic-answer" }],
          },
        },
      });
      observe({
        method: "rawResponse/completed",
        params: completion("root", `response_${turnId}`, turnId),
      });
      // Reproduce the asynchronous gap where the old guard sent an interrupt
      // after the provider finished but before app-server completed the turn.
      await budget.settle();
      const terminal = {
        method: "turn/completed",
        params: {
          threadId: "root",
          turn: protocolTurn(
            turnId,
            interrupted.includes(turnId) ? "interrupted" : "completed",
          ),
        },
      } satisfies ServerNotification;
      observe(terminal);
      assert.deepEqual(
        new EventNormalizer().normalize(terminal.method, terminal.params),
        [{ finishReason: "stop" }],
      );
    }
    assert.deepEqual(interrupted, []);
    assert.deepEqual(budget.stats(), { parent: 2, child: 0, total: 2 });
    assert.throws(() => budget.assertCanStartTurn(), /prevents another turn/u);
  }
});

test("a final answer cannot exempt tools, child work, or a later response from the ceiling", async () => {
  for (const scenario of [
    "tool",
    "child",
    "later-response",
    "commentary",
    "unknown",
  ] as const) {
    const budget = new ProviderCallBudget(
      scenario === "later-response" ? 2 : 1,
    );
    budget.activateRootTurn("root", "turn_root");
    const interrupted: string[] = [];
    const interrupt = async ({ turnId }: { turnId: string }): Promise<void> => {
      interrupted.push(turnId);
    };
    const observe = (notification: ServerNotification): void =>
      budget.observe(notification.method, notification.params, interrupt);
    const threadId = scenario === "child" ? "child" : "root";
    const turnId = `turn_${threadId}`;
    observe({
      method: "rawResponseItem/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "message",
          role: "assistant",
          phase: scenario === "commentary" ? "commentary" : "final_answer",
          content: [{ type: "output_text", text: "synthetic-answer" }],
        },
      },
    });
    if (scenario === "tool" || scenario === "unknown")
      observe({
        method: "rawResponseItem/completed",
        params: {
          threadId,
          turnId,
          item:
            scenario === "tool"
              ? {
                  type: "function_call",
                  call_id: "call_1",
                  name: "synthetic_tool",
                  arguments: "{}",
                }
              : { type: "other" },
        },
      });
    observe({
      method: "rawResponse/completed",
      params: completion(threadId, "response_1", turnId),
    });
    if (scenario === "later-response")
      observe({
        method: "rawResponse/completed",
        params: completion(threadId, "response_2", turnId),
      });
    await budget.settle();
    assert.deepEqual(interrupted, ["turn_root"], scenario);
  }
});

test("provider-call accounting fails explicitly when child events are absent or malformed", () => {
  const noChildren = new ProviderCallBudget(24);
  assert.throws(
    () => noChildren.assertChildCallsObserved(),
    /observed no child-thread rawResponse\/completed events/u,
  );
  noChildren.observe(
    "rawResponse/completed",
    completion("unrelated-child", "unrelated-response"),
    async () => {},
  );
  assert.doesNotThrow(() => noChildren.assertChildCallsObserved());
  assert.throws(
    () => noChildren.assertChildThreadCallsObserved("expected-child"),
    /expected child thread "expected-child"/u,
  );

  const malformed = new ProviderCallBudget(24);
  malformed.observe(
    "rawResponse/completed",
    { threadId: "root" },
    async () => {},
  );
  assert.throws(
    () => malformed.stats(),
    /without string threadId and responseId fields/u,
  );
});

test("provider-call accounting preserves deduplication and totals across transport generations", () => {
  const budget = new ProviderCallBudget(24);
  const interrupt = async (): Promise<void> => {};
  budget.registerRootThread("root");
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_before_restart"),
    interrupt,
  );
  budget.observe(
    "rawResponse/completed",
    completion("child", "child_before_restart"),
    interrupt,
  );

  // A replacement app-server can replay boundaries from the retained thread.
  budget.registerRootThread("root");
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_before_restart"),
    interrupt,
  );
  budget.observe(
    "rawResponse/completed",
    completion("child", "child_before_restart"),
    interrupt,
  );
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_after_restart"),
    interrupt,
  );

  assert.deepEqual(budget.stats(), { parent: 2, child: 1, total: 3 });
  budget.assertChildThreadCallsObserved("child");
});

test("provider-call accounting accepts an exact ceiling after work is complete", () => {
  const budget = new ProviderCallBudget(1);
  budget.registerRootThread("root");
  budget.observe(
    "rawResponse/completed",
    completion("child", "child_1"),
    async () => {
      throw new Error("no completed turn should be interrupted");
    },
  );

  assert.deepEqual(budget.stats(), { parent: 0, child: 1, total: 1 });
});

test("provider-call accounting surfaces asynchronous ceiling-interrupt failure", async () => {
  const budget = new ProviderCallBudget(1);
  budget.registerRootThread("root");
  budget.activateRootTurn("root", "turn_root");
  budget.observe(
    "rawResponse/completed",
    completion("root", "parent_1", "turn_root"),
    async () => {
      throw new Error("interrupt unavailable");
    },
  );

  await assert.rejects(
    budget.settle(),
    /ceiling interrupt failed: interrupt unavailable/u,
  );
  assert.throws(
    () => budget.stats(),
    /ceiling interrupt failed: interrupt unavailable/u,
  );
});

test("live prerequisites reject missing workspace-write and live web policy before requests", () => {
  assert.doesNotThrow(() =>
    assertLivePolicyPrerequisites(UNRESTRICTED_POLICY_REQUIREMENTS),
  );
  assert.throws(
    () =>
      assertLivePolicyPrerequisites({
        ...UNRESTRICTED_POLICY_REQUIREMENTS,
        allowedSandboxModes: ["read-only"],
      }),
    /disallows workspace-write sandboxing/u,
  );
  assert.throws(
    () =>
      assertLivePolicyPrerequisites({
        ...UNRESTRICTED_POLICY_REQUIREMENTS,
        allowedWebSearchModes: ["disabled"],
      }),
    /disallows live web search/u,
  );
});

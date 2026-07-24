import { describe, expect, test } from "vitest";
import { isBoundedObservationCommand } from "./chat-contract.js";

/** Exercises the bounded command-display variants used by the live contract. */
describe("isBoundedObservationCommand", () => {
  test.each([
    "cat .codex-contract-observation",
    " cat .codex-contract-observation ",
    "cat './.codex-contract-observation'",
    'cat ".codex-contract-observation"',
    "/bin/cat -- .codex-contract-observation",
    "/usr/bin/cat ./.codex-contract-observation",
    "sh -lc cat .codex-contract-observation",
    "sh -c 'cat -- ./.codex-contract-observation'",
    "/bin/sh -lc 'cat .codex-contract-observation'",
    `/bin/sh -lc "cat './.codex-contract-observation'"`,
    '/usr/bin/bash -lc "cat .codex-contract-observation"',
    "dash -lc cat .codex-contract-observation",
    "/bin/ksh -lc 'cat .codex-contract-observation'",
    '/usr/bin/zsh -lc "cat .codex-contract-observation"',
  ])("accepts the bounded spelling %s", (command) => {
    expect(isBoundedObservationCommand(command)).toBe(true);
  });

  test.each([
    "cat /.codex-contract-observation",
    "cat .codex-contract-observation extra",
    "cat --",
    "cat .codex-contract-observation 2>/dev/null",
    "cat .codex-contract-observation > copy",
    "fish -lc cat .codex-contract-observation",
    "/tmp/sh -lc cat .codex-contract-observation",
    "sh -lc cat .codex-contract-observation extra",
    "sh -lc 'cat .codex-contract-observation; whoami'",
    'sh -lc "cat .codex-contract-observation && whoami"',
    "cat .codex-contract-observation | whoami",
    "cat .codex-contract-observation; whoami",
    "cat .codex-contract-observation && whoami",
    "pwd",
  ])("rejects the out-of-contract spelling %s", (command) => {
    expect(isBoundedObservationCommand(command)).toBe(false);
  });
});

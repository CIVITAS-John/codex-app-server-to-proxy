import { describe, expect, test } from "vitest";
import { isBoundedPwdCommand } from "./chat-contract.js";

/** Exercises the exact command-display boundary used by the live contract. */
describe("isBoundedPwdCommand", () => {
  test.each([
    "pwd",
    "sh -lc pwd",
    "/bin/sh -lc 'pwd'",
    '/usr/bin/bash -lc "pwd"',
    "dash -lc pwd",
    "/bin/ksh -lc 'pwd'",
    '/usr/bin/zsh -lc "pwd"',
  ])("accepts the bounded spelling %s", (command) => {
    expect(isBoundedPwdCommand(command)).toBe(true);
  });

  test.each([
    " pwd",
    "pwd ",
    "/bin/pwd",
    "fish -lc pwd",
    "/tmp/sh -lc pwd",
    "sh -c pwd",
    "sh -lc pwd extra",
    "sh -lc 'pwd; whoami'",
    'sh -lc "pwd && whoami"',
    "pwd | whoami",
    "pwd; whoami",
    "pwd && whoami",
  ])("rejects the out-of-contract spelling %s", (command) => {
    expect(isBoundedPwdCommand(command)).toBe(false);
  });
});

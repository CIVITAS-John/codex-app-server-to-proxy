import { spawn } from "node:child_process";
import { once } from "node:events";
import type { JsonRpcTransport } from "./json-rpc.js";
import type { Logger } from "../core/logger.js";
import { listenForAbort, withDeadline } from "../core/abort.js";

/** Minimal account/read fields used by the authentication flow. */
type AccountResponse = { account?: unknown; requiresOpenaiAuth?: boolean };
/** Supported account/login/start response variants. */
type LoginResponse =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };
/** Minimal account/login/completed notification payload. */
type LoginCompleted = {
  loginId?: string | null;
  success?: boolean;
  error?: string | null;
};

/** Dependencies and policy inputs for authentication. */
export interface AuthenticationOptions {
  rpc: JsonRpcTransport;
  log: Logger;
  timeoutMs: number;
  interactive: boolean;
  terminal: (message: string) => void;
  launch?: (url: string) => Promise<boolean>;
  signal?: AbortSignal;
}

/** Ensures app-server has an authenticated OpenAI account. */
export async function ensureAuthenticated(
  options: AuthenticationOptions,
): Promise<void> {
  const account = (await options.rpc.request(
    "account/read",
    { refreshToken: false },
    options.signal,
  )) as AccountResponse;
  if (typeof account.requiresOpenaiAuth !== "boolean")
    throw new Error(
      "account/read returned an invalid requiresOpenaiAuth value.",
    );
  if (!account.requiresOpenaiAuth || account.account != null) return;
  const useDeviceCode = !options.interactive;
  await startAndWaitForLogin(options, useDeviceCode);
}

/** Starts a browser or device-code login and waits for its notification. */
async function startAndWaitForLogin(
  options: AuthenticationOptions,
  useDeviceCode: boolean,
): Promise<void> {
  let loginId: string | undefined;
  let earlyCompletion: LoginCompleted | undefined;
  let settle!: (error?: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  });
  void completion.catch(() => undefined);
  const notification = (method: string, raw: unknown): void => {
    if (
      method !== "account/login/completed" ||
      typeof raw !== "object" ||
      raw === null
    )
      return;
    const result = raw as LoginCompleted;
    if (loginId === undefined) {
      earlyCompletion = result;
      return;
    }
    if (result.loginId != null && result.loginId !== loginId) return;
    settle(
      result.success
        ? undefined
        : new Error(result.error ?? "ChatGPT login failed."),
    );
  };
  options.rpc.on("notification", notification);

  try {
    await withDeadline(
      options.signal,
      {
        milliseconds: options.timeoutMs,
        timeoutReason: new Error("ChatGPT login timed out."),
        abortReason: (signal) =>
          signal.reason instanceof Error
            ? signal.reason
            : new Error("ChatGPT login cancelled."),
      },
      async (deadlineSignal) => {
        const disposeDeadline = listenForAbort(
          deadlineSignal,
          (abortedSignal) =>
            settle(
              abortedSignal.reason instanceof Error
                ? abortedSignal.reason
                : new Error("ChatGPT login cancelled."),
            ),
        );
        try {
          const login = (await options.rpc.request(
            "account/login/start",
            { type: useDeviceCode ? "chatgptDeviceCode" : "chatgpt" },
            options.signal,
          )) as LoginResponse;
          loginId = login.loginId;
          if (earlyCompletion !== undefined)
            notification("account/login/completed", earlyCompletion);

          if (login.type === "chatgpt") {
            const launched = await (options.launch ?? launchBrowser)(
              login.authUrl,
            );
            if (!launched) {
              options.terminal(
                `Open this URL to sign in to ChatGPT:\n${login.authUrl}\n`,
              );
              options.log("warn", "browser_launch_failed", {
                login_url: "[REDACTED]",
              });
            } else options.log("info", "browser_launch_succeeded");
          } else {
            options.terminal(
              `Open ${login.verificationUrl} and enter code ${login.userCode}.\n`,
            );
            options.log("info", "device_code_login_started", {
              verification_url: "[REDACTED]",
              user_code: "[REDACTED]",
            });
          }
          await completion;
        } finally {
          disposeDeadline();
        }
      },
    );
  } finally {
    options.rpc.off("notification", notification);
  }
}

/** Opens a login URL with the platform browser without invoking a shell. */
export async function launchBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    const [code] = await once(child, "exit");
    return code === 0;
  } catch {
    return false;
  }
}

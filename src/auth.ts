import { spawn } from "node:child_process";
import { once } from "node:events";
import type { JsonRpcTransport } from "./json-rpc.js";
import type { Logger } from "./logger.js";

type AccountResponse = { account?: unknown; requiresOpenaiAuth?: boolean };
type LoginResponse =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };
type LoginCompleted = {
  loginId?: string | null;
  success?: boolean;
  error?: string | null;
};

export interface AuthenticationOptions {
  rpc: JsonRpcTransport;
  log: Logger;
  timeoutMs: number;
  interactive: boolean;
  terminal: (message: string) => void;
  launch?: (url: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export async function ensureAuthenticated(
  options: AuthenticationOptions,
): Promise<void> {
  const account = (await options.rpc.request(
    "account/read",
    { refreshToken: false },
    options.signal,
  )) as AccountResponse;
  if (!account.requiresOpenaiAuth || account.account != null) return;
  const useDeviceCode = !options.interactive;
  await startAndWaitForLogin(options, useDeviceCode);
}

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
  const abort = (): void =>
    settle(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("ChatGPT login cancelled."),
    );
  const timer = setTimeout(
    () => settle(new Error("ChatGPT login timed out.")),
    options.timeoutMs,
  );
  timer.unref();
  options.rpc.on("notification", notification);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (options.signal?.aborted) abort();
    const login = (await options.rpc.request(
      "account/login/start",
      { type: useDeviceCode ? "chatgptDeviceCode" : "chatgpt" },
      options.signal,
    )) as LoginResponse;
    loginId = login.loginId;
    if (earlyCompletion !== undefined)
      notification("account/login/completed", earlyCompletion);

    if (login.type === "chatgpt") {
      const launched = await (options.launch ?? launchBrowser)(login.authUrl);
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
    clearTimeout(timer);
    options.rpc.off("notification", notification);
    options.signal?.removeEventListener("abort", abort);
  }
}

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

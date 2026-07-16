import { homedir } from "node:os";
import { sep } from "node:path";

/** Removes common URL, credential, and local-path forms from diagnostics. */
export function redact(value: string, root: string): string {
  const home = homedir();
  let result = value;
  // Redact the configured root before the home directory: a root nested under
  // home must be masked as one unit ([REDACTED_CWD]) rather than having its
  // home prefix rewritten first, which would leak the home-relative tail.
  // Skip trivially broad roots (empty, the filesystem root, or home itself) to
  // avoid over-redacting unrelated text.
  if (root && root !== sep && root !== home)
    result = result.replaceAll(root, "[REDACTED_CWD]");
  return result
    .replaceAll(home, "[REDACTED_HOME]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\b(token|code|secret)=\S+/gi, "$1=[REDACTED]");
}

import { homedir } from "node:os";
import { isAbsolute, parse, sep } from "node:path";

/** Identifies a nonempty path that is not itself a filesystem root. */
function isRedactablePath(path: string): boolean {
  return path.length > 0 && parse(path).root !== path;
}

/** Removes common URL, credential, and local-path forms from diagnostics. */
export function redact(
  value: string,
  root: string,
  sensitivePaths: readonly string[] = [],
): string {
  const home = homedir();
  let result = value;
  const replacements = [
    ...sensitivePaths
      .filter(
        (path) =>
          path.length > 1 &&
          isRedactablePath(path) &&
          (isAbsolute(path) || path.includes(sep)),
      )
      .map((path) => [path, "[REDACTED_PATH]"] as const),
    ...(isRedactablePath(root) && root !== home
      ? ([[root, "[REDACTED_CWD]"]] as const)
      : []),
    [home, "[REDACTED_HOME]"] as const,
  ].sort(([left], [right]) => right.length - left.length);
  // Replace the most specific paths first so masking a parent never exposes a
  // sensitive child as a readable relative suffix.
  const seen = new Set<string>();
  for (const [path, replacement] of replacements) {
    if (seen.has(path)) continue;
    seen.add(path);
    result = result.replaceAll(path, replacement);
  }
  return result
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\b(token|code|secret)=\S+/gi, "$1=[REDACTED]");
}

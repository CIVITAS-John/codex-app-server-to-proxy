import { createHash } from "node:crypto";

/** Canonicalizes JSON values so equivalent structures serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Returns a stable SHA-256 binding for a JSON-compatible value. */
export function bindingHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Narrows an unknown value to a non-null, non-array object record. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

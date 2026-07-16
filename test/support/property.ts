import fc from "fast-check";

/** Stable seed and bounded run count used by every required property test. */
export const propertyOptions = {
  seed: 17_072_026,
  numRuns: 40,
} as const;

/** JSON-compatible values bounded to keep required CI fast and diagnostics small. */
export const boundedJsonValue = fc.jsonValue({
  maxDepth: 4,
  noUnicodeString: false,
});

/** Applies positive fragment widths until the complete wire frame is consumed. */
export function fragmentByWidths(
  value: string,
  widths: readonly number[],
): Buffer[] {
  const encoded = Buffer.from(value, "utf8");
  const fragments: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < encoded.length) {
    const width = Math.max(1, widths[index % widths.length] ?? encoded.length);
    fragments.push(encoded.subarray(offset, offset + width));
    offset += width;
    index += 1;
  }
  return fragments;
}

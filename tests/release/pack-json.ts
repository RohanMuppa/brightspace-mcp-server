/**
 * `npm pack --dry-run --json` has printed two shapes: an array with one entry
 * per package (npm 10 and earlier releases), and an object keyed by package
 * name (npm 12). Both entries carry the same `files` list, so pick the entry
 * out of whichever shape arrived and return its paths.
 */

type PackEntry = { files: Array<{ path: string }> };

function isPackEntry(value: unknown): value is PackEntry {
  return typeof value === "object" && value !== null && Array.isArray((value as PackEntry).files);
}

export function packedFilePaths(json: unknown): string[] {
  const entry =
    json !== null && typeof json === "object"
      ? (Array.isArray(json) ? json : Object.values(json))[0]
      : undefined;
  if (!isPackEntry(entry)) {
    throw new Error(`Unrecognized npm pack --json output: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return entry.files.map((f) => f.path);
}

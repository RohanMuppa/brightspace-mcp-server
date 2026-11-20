/**
 * D2L answers the dropbox submission routes in one of two shapes, depending on
 * the school: a flat list of submissions, or EntityDropbox entries
 * ({ Entity, Status, Feedback, Submissions: [...] }) that carry the
 * submissions, and so their Files, one level down. Either may also arrive
 * wrapped as { Objects: [...] }.
 */
export function flattenDropboxSubmissions<T extends object>(
  raw: T[] | { Objects?: T[] } | null | undefined
): T[] {
  const entries: T[] = Array.isArray(raw) ? raw : raw?.Objects ?? [];
  // An entry that has a Submissions array is an EntityDropbox wrapper, never a submission
  // itself, so it is replaced by its children. A null entry is skipped, not a crash.
  return entries.filter((e) => e != null).flatMap((e) => {
    const nested = (e as { Submissions?: unknown }).Submissions;
    return Array.isArray(nested) ? (nested as T[]) : [e];
  });
}

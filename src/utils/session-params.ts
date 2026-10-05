/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** D2L's per-session query params, matched case-insensitively by name. */
const SESSION_QUERY_PARAMS = new Set(["d2lsessionval", "d2lsecuresessionval", "_"]);

/**
 * Strip D2L's per-session query params (`d2lSessionVal`, `d2lSecureSessionVal`,
 * and the `_` cache-buster) from a URL before it is shown to the model or user.
 * Everything else about the URL -- scheme, path, routing params such as
 * `ou`/`type`/`rcode`, the fragment -- is left untouched, and a relative URL
 * stays relative. Use the original URL for any authenticated request; this is
 * only for public output.
 */
export function stripD2lSessionParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;
  const earlyHash = url.indexOf("#");
  if (earlyHash >= 0 && earlyHash < queryStart) {
    // The "?" falls inside the fragment (e.g. "#frag?x=1"), not a real query
    // string -- nothing to strip, and treating it as one would mangle the
    // fragment.
    return url;
  }
  const hashStart = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  const hash = hashStart < 0 ? "" : url.slice(hashStart);
  const kept = query
    .split("&")
    .filter((param) => param !== "" && !SESSION_QUERY_PARAMS.has(param.split("=")[0].toLowerCase()));
  return url.slice(0, queryStart) + (kept.length > 0 ? `?${kept.join("&")}` : "") + hash;
}

/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Which video platform a content topic's URL points at, and the identifiers
 * each platform's transcript adapter needs. get_course_content's own
 * `typeFilter: "video"` match is a blunt `youtube|vimeo|kaltura|video` regex
 * on the URL; this is the more accurate classifier get_video_transcript
 * needs before it can pick an adapter.
 */

export type VideoPlatform =
  | "kaltura"
  | "youtube"
  | "panopto"
  | "yuja"
  | "echo360"
  | "vimeo"
  | "unknown";

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True if `host` is exactly `domain` or a subdomain of it, e.g. "www.youtube.com" matches "youtube.com". */
function isDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * True if `label` appears as one of `host`'s dot-separated segments, e.g.
 * "mediaspace.kaltura.com" has the label "kaltura". Used instead of a bare
 * substring test so a lookalike host like "fakekaltura.com" or
 * "notyuja.example.com" doesn't get misclassified as the real platform.
 */
function hasHostLabel(host: string, label: string): boolean {
  return host.split(".").includes(label);
}

/**
 * Kaltura's KAF "browseAndEmbed" front end (what a school's own branded
 * domain, e.g. BoilerCast, typically uses) puts params as path segments
 * rather than a query string: `/browseandembed/index/media/entry_id/1_abc/wid/_123`.
 */
function pathSegmentParam(pathname: string, name: string): string | null {
  const match = pathname.match(new RegExp(`/${name}/([^/]+)`, "i"));
  return match?.[1] ?? null;
}

export function detectVideoPlatform(url: string): VideoPlatform {
  const host = safeHostname(url);
  if (!host) return "unknown";

  // Kaltura is embedded either from its own multi-tenant domains (kaltura.com,
  // mediaspace.kaltura.com) or from a school's own KAF front end (e.g.
  // BoilerCast at Purdue), which is why entry_id/wid are also checked as
  // query params or path segments before falling back to "unknown".
  if (hasHostLabel(host, "kaltura")) return "kaltura";
  if (isDomainOrSubdomain(host, "youtube.com") || isDomainOrSubdomain(host, "youtu.be")) return "youtube";
  if (hasHostLabel(host, "panopto")) return "panopto";
  if (hasHostLabel(host, "yuja")) return "yuja";
  if (hasHostLabel(host, "echo360")) return "echo360";
  if (hasHostLabel(host, "vimeo")) return "vimeo";
  if (extractKalturaIds(url)) return "kaltura";
  return "unknown";
}

export interface KalturaIds {
  partnerId: string;
  entryId: string;
}

/** Kaltura embeds carry the entry and partner ID as query params or path segments; naming varies by embed generator. */
export function extractKalturaIds(url: string): KalturaIds | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const pathname = parsed.pathname;

  const pathEntryMatch = pathname.match(/\/(?:media\/t|id|entryid)\/([\w-]+)/i);
  const entryId =
    params.get("entry_id") ??
    params.get("entryId") ??
    pathEntryMatch?.[1] ??
    pathSegmentParam(pathname, "entry_id") ??
    null;

  const widParam =
    params.get("wid") ??
    params.get("partner_id") ??
    params.get("partnerId") ??
    params.get("pid") ??
    pathSegmentParam(pathname, "wid") ??
    pathSegmentParam(pathname, "partner_id");
  const partnerId = widParam ? widParam.replace(/^_/, "") : null;

  if (!entryId || !partnerId) return null;
  return { partnerId, entryId };
}

/** youtube.com/watch?v=, youtu.be/, and /embed/ links. */
export function extractYouTubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  if (isDomainOrSubdomain(host, "youtu.be")) {
    return parsed.pathname.slice(1).split("/")[0] || null;
  }
  if (isDomainOrSubdomain(host, "youtube.com") || isDomainOrSubdomain(host, "youtube-nocookie.com")) {
    const v = parsed.searchParams.get("v");
    if (v) return v;
    const embedMatch = parsed.pathname.match(/\/embed\/([\w-]+)/);
    if (embedMatch) return embedMatch[1];
  }
  return null;
}

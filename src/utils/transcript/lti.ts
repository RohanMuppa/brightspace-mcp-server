/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Brightspace hands out an LTI tool (BoilerCast's Kaltura KAF, for one) as a
 * relative quickLink such as `/d2l/common/dialogs/quickLink/quickLink.d2l?type=lti&rcode=...`,
 * which names no video at all. Requesting it with the user's session yields
 * the LTI launch page: an auto-submitting form whose action, or one of whose
 * hidden fields, is the tool URL that does name the video. This reads that
 * page; fetching it is the caller's job.
 */

import { detectVideoPlatform, extractKalturaIds, extractYouTubeVideoId } from "./platform.js";

/** What a launch page leads to: the video itself, another Brightspace page to request, or nothing recognizable. */
export type LaunchPageFinding = { videoUrl: string } | { nextPath: string } | null;

/** A link into the user's own Brightspace, which only an authenticated request can follow. */
export function isBrightspaceRelativeLink(url: string): boolean {
  return url.startsWith("/d2l/");
}

/**
 * The path and query of a link into the user's own Brightspace, or null for
 * anything else. A relative `/d2l/` link qualifies, and so does an absolute
 * URL whose origin is exactly the configured Brightspace origin and whose
 * path starts with `/d2l/`, so both take the same authenticated route. A URL
 * on any other origin (a lookalike host, an http: downgrade, a different
 * port, a protocol-relative `//host/...`, or one carrying userinfo) is never
 * a Brightspace link: the session must not travel there.
 */
export function toBrightspacePath(url: string, origin?: string): string | null {
  const trimmed = url.trim();
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(origin ?? "https://brightspace.invalid").origin;
  } catch {
    return null;
  }
  const relative = isBrightspaceRelativeLink(trimmed);
  if (!relative && (!origin || !/^https?:\/\//i.test(trimmed))) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, expectedOrigin);
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin || parsed.username || parsed.password) return null;
  if (!parsed.pathname.startsWith("/d2l/")) return null;
  return `${parsed.pathname}${parsed.search}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tagAttributes(html: string, tag: string): Map<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))].map(
    element =>
      new Map(
        [...element[0].matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [
          match[1].toLowerCase(),
          decodeEntities(match[3]),
        ])
      )
  );
}

/** True when an adapter could fetch a transcript from `url`, or name the platform it can't yet. */
function namesVideo(url: string): boolean {
  switch (detectVideoPlatform(url)) {
    case "unknown":
      return false;
    case "kaltura":
      return extractKalturaIds(url) !== null;
    case "youtube":
      return extractYouTubeVideoId(url) !== null;
    default:
      return true;
  }
}

/**
 * Kaltura KAF's LTI consumer key is the school's Kaltura partner ID, and a
 * school-branded KAF launch URL often carries only the entry ID, so the key
 * fills in the `wid` the URL left out.
 */
function asVideoUrl(candidate: string, consumerKey: string | undefined): string | null {
  if (!/^https?:\/\//i.test(candidate)) return null;
  if (namesVideo(candidate)) return candidate;
  if (!consumerKey || !/^\d+$/.test(consumerKey)) return null;
  let withPartner: URL;
  try {
    withPartner = new URL(candidate);
  } catch {
    return null;
  }
  if (withPartner.searchParams.has("wid")) return null;
  withPartner.searchParams.set("wid", `_${consumerKey}`);
  return namesVideo(withPartner.href) ? withPartner.href : null;
}

/**
 * Read an LTI launch page for the video it opens, or for the one Brightspace
 * page it frames. Pass the Brightspace `origin` so an absolute link back into
 * the same Brightspace counts as a page to follow; without it only relative
 * `/d2l/` links do.
 */
export function readLtiLaunchPage(html: string, origin?: string): LaunchPageFinding {
  const inputs = tagAttributes(html, "input");
  const consumerKey = inputs.find(input => input.get("name") === "oauth_consumer_key")?.get("value");
  const candidates = [
    ...tagAttributes(html, "form").map(form => form.get("action")),
    ...tagAttributes(html, "iframe").map(frame => frame.get("src")),
    ...inputs.map(input => input.get("value")),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const videoUrl = asVideoUrl(candidate, consumerKey);
    if (videoUrl) return { videoUrl };
  }
  for (const candidate of candidates) {
    const nextPath = toBrightspacePath(candidate, origin);
    if (nextPath) return { nextPath };
  }
  return null;
}

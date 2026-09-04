/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT - see LICENSE file for details.
 */

import type { D2LApiClient } from "./client.js";
import { log } from "../utils/logger.js";

/**
 * Bookmark pagination for the two envelopes D2L answers with.
 *
 * Both loops are bounded twice over: a page ceiling, and a set of the
 * bookmarks already followed. A server that keeps saying "there is more" and
 * hands back the same bookmark would otherwise hang the tool forever.
 */

const MAX_PAGES = 200;

/** The { Items, PagingInfo } envelope, used by enrollments. */
interface PagedItems<T> {
  Items?: T[] | null;
  PagingInfo?: { HasMoreItems?: boolean; Bookmark?: string | null } | null;
}

/** The { Objects, Next } envelope, used by the paged classlist. */
interface PagedObjects<T> {
  Objects?: T[] | null;
  Next?: string | null;
}

export interface PaginateOptions {
  /** Cache TTL, passed through to the client on every page. */
  ttl?: number;
}

/** The first path with a bookmark appended, opening the query string if needed. */
function withBookmark(firstPath: string, bookmark: string): string {
  const separator = firstPath.includes("?") ? "&" : "?";
  return `${firstPath}${separator}bookmark=${encodeURIComponent(bookmark)}`;
}

/**
 * Every item across every page of a { Items, PagingInfo } endpoint, in order.
 */
export async function fetchAllItems<T>(
  apiClient: D2LApiClient,
  firstPath: string,
  options?: PaginateOptions
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let path: string | null = firstPath;
  let pages = 0;

  while (path !== null) {
    if (pages >= MAX_PAGES) {
      log("WARN", `Pagination stopped at the ${MAX_PAGES} page ceiling`, { firstPath });
      break;
    }

    const response: PagedItems<T> = await apiClient.get<PagedItems<T>>(path, options);
    pages += 1;
    items.push(...(response?.Items ?? []));

    const paging = response?.PagingInfo;
    const bookmark = paging?.Bookmark;
    if (!paging?.HasMoreItems || !bookmark) break;
    if (seen.has(bookmark)) {
      log("WARN", "Pagination stopped: the server repeated a bookmark", { firstPath });
      break;
    }

    seen.add(bookmark);
    path = withBookmark(firstPath, bookmark);
  }

  return items;
}

/**
 * Every object across every page of a { Objects, Next } endpoint, in order.
 *
 * Next arrives either as a full next-page URL or as a bare bookmark, so the
 * absolute form is reduced to its path and query and anything else is treated
 * as a bookmark against the first path.
 */
export async function fetchAllObjects<T>(
  apiClient: D2LApiClient,
  firstPath: string,
  options?: PaginateOptions
): Promise<T[]> {
  const objects: T[] = [];
  const seen = new Set<string>();
  let path: string | null = firstPath;
  let pages = 0;

  while (path !== null) {
    if (pages >= MAX_PAGES) {
      log("WARN", `Pagination stopped at the ${MAX_PAGES} page ceiling`, { firstPath });
      break;
    }

    const response: PagedObjects<T> = await apiClient.get<PagedObjects<T>>(path, options);
    pages += 1;
    objects.push(...(response?.Objects ?? []));

    const next = response?.Next;
    if (!next) break;
    if (seen.has(next)) {
      log("WARN", "Pagination stopped: the server repeated a next page", { firstPath });
      break;
    }

    seen.add(next);
    path = nextPath(firstPath, next);
  }

  return objects;
}

/** A Next value resolved to a request path. */
function nextPath(firstPath: string, next: string): string {
  if (/^https?:\/\//i.test(next)) {
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
  }
  // A Next that begins with a slash is already a path, not a bookmark.
  // Appending it as one would ask for a page that does not exist.
  if (next.startsWith("/")) {
    return next;
  }
  return withBookmark(firstPath, next);
}

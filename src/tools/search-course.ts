/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError } from "../api/index.js";
import { SearchCourseSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { fetchRootContent, buildContentTree } from "./get-course-content.js";
import { fetchCourseNews, isPublishedNewsItem, mapNewsItem } from "./get-announcements.js";
import { fetchForums, fetchForumTopics } from "./get-discussions.js";

export type SearchResultKind = "module" | "topic" | "announcement" | "discussion";

/**
 * One searchable unit, flattened out of whichever source it came from. `body`
 * is whatever free text that source carries (description, post body) — never
 * HTML, so scoring and snippeting never see markup noise.
 */
export interface SearchEntry {
  kind: SearchResultKind;
  id: number;
  title: string;
  body: string;
  moduleTitle?: string;
  url?: string;
}

export interface SearchResult {
  kind: SearchResultKind;
  id: number;
  title: string;
  snippet: string;
  moduleTitle?: string;
  url?: string;
  score: number;
}

/** A query term matched in the title outranks the same term only in the body. */
const TITLE_WEIGHT = 10;
const BODY_WEIGHT = 1;
/**
 * Large enough that an entry matching every query term always outranks one
 * matching only some of them, regardless of how those partial matches are
 * distributed between title and body.
 */
const ALL_TERMS_BONUS = 1000;

/**
 * Lowercase, split on anything that isn't a Unicode letter or digit (so
 * accented and non-Latin query terms tokenize the same as their matches
 * instead of being shredded at every diacritic), and drop both empty and
 * single-character residue left over from the split.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
}

/**
 * Score one entry against the already-tokenized query. A term counts once,
 * against whichever field it was found in first (title preferred), so a term
 * present in both title and body is not double-counted into a false "both
 * fields matched" signal.
 */
export function scoreEntry(entry: SearchEntry, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const titleTokens = tokenize(entry.title);
  const bodyTokens = tokenize(entry.body);

  let score = 0;
  let matchedTerms = 0;

  for (const term of queryTerms) {
    if (titleTokens.some((t) => t.includes(term))) {
      score += TITLE_WEIGHT;
      matchedTerms++;
    } else if (bodyTokens.some((t) => t.includes(term))) {
      score += BODY_WEIGHT;
      matchedTerms++;
    }
  }

  if (matchedTerms === 0) return 0;
  if (matchedTerms === queryTerms.length) score += ALL_TERMS_BONUS;
  return score;
}

/** First case-insensitive occurrence of any query term in text, or -1. */
function firstMatchIndex(text: string, queryTerms: string[]): number {
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (first === -1 || idx < first)) first = idx;
  }
  return first;
}

/**
 * A window of at most maxLen characters around matchIndex, with an ellipsis
 * on whichever side(s) were cut — the ellipsis itself counts against maxLen
 * so the result never exceeds it.
 */
export function buildSnippet(text: string, matchIndex: number, maxLen = 200): string {
  if (!text) return "";
  if (matchIndex < 0 || text.length <= maxLen) {
    return text.length <= maxLen ? text : text.slice(0, maxLen - 1).trimEnd() + "…";
  }

  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, matchIndex - half);
  let end = start + maxLen;
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - maxLen);
  }

  const hasPrefix = start > 0;
  const hasSuffix = end < text.length;
  const budget = maxLen - (hasPrefix ? 1 : 0) - (hasSuffix ? 1 : 0);
  let slice = text.slice(start, end).trim();
  if (slice.length > budget) slice = slice.slice(0, budget);

  return (hasPrefix ? "…" : "") + slice + (hasSuffix ? "…" : "");
}

/**
 * Score, snippet, sort, and trim every entry to `limit`. Pure and
 * network-free so ranking can be tested without mocking the API client.
 */
export function rankEntries(entries: SearchEntry[], query: string, limit: number): SearchResult[] {
  const queryTerms = tokenize(query);
  const results: SearchResult[] = [];

  for (const entry of entries) {
    const score = scoreEntry(entry, queryTerms);
    if (score <= 0) continue;

    const snippetSource = entry.body.trim() ? entry.body : entry.title;
    const snippet = buildSnippet(snippetSource, firstMatchIndex(snippetSource, queryTerms));

    results.push({
      kind: entry.kind,
      id: entry.id,
      title: entry.title,
      snippet,
      ...(entry.moduleTitle ? { moduleTitle: entry.moduleTitle } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Flatten the content tree built by get_course_content's own buildContentTree
 * into search entries, carrying each topic's immediate parent module title
 * along for context.
 */
export function flattenContentTree(tree: any[], moduleTitle?: string): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const item of tree) {
    if (item.type === "module") {
      entries.push({
        kind: "module",
        id: item.id,
        title: item.title,
        body: item.description ?? "",
        ...(moduleTitle ? { moduleTitle } : {}),
      });
      entries.push(...flattenContentTree(item.children ?? [], item.title));
    } else if (item.type === "topic") {
      const body = [item.description, item.content].filter(Boolean).join("\n\n");
      entries.push({
        kind: "topic",
        id: item.id,
        title: item.title,
        body,
        ...(moduleTitle ? { moduleTitle } : {}),
        ...(item.url ? { url: item.url } : {}),
      });
    }
  }
  return entries;
}

/** A short, safe description of why a source's fetch failed — never the raw error. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "no access (403)";
    if (error.status === 404) return "not found (404)";
    return `request failed (${error.status})`;
  }
  return "request failed";
}

/**
 * Register search_course tool
 */
export function registerSearchCourse(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "search_course",
    {
      title: "Search Course",
      description:
        "Search a course's content (modules, topics, file names), announcements, and discussion forums/topics by keyword in a single call, instead of reading the whole content tree. Use this when the user wants to find something specific, e.g. 'find the midterm review slides' or 'did anyone post about office hours'. Results are ranked: a result matching every query term ranks above one matching only some, and within that, a match in the title ranks above one only in the body text. If one source (e.g. discussions) can't be read, it's skipped and named in `note` rather than failing the whole search. This fans out over the entire content tree, announcements, and every discussion forum, so it can be slower than calling a single tool like get_course_content directly.",
      inputSchema: SearchCourseSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "search_course tool called", { args });

        const { courseId, query, limit } = SearchCourseSchema.parse(args);

        const entries: SearchEntry[] = [];
        const notes: string[] = [];

        // Content: modules and topics
        try {
          const rootModules = await fetchRootContent(apiClient, courseId);
          const tree = await buildContentTree(apiClient, courseId, rootModules, new Map(), "all");
          entries.push(...flattenContentTree(tree));
        } catch (error) {
          log("DEBUG", `search_course: content fetch failed for course ${courseId}`, error);
          notes.push(`content: ${describeFailure(error)}`);
        }

        // Announcements
        try {
          const newsItems = await fetchCourseNews(apiClient, courseId);
          for (const raw of newsItems.filter(isPublishedNewsItem)) {
            const announcement = mapNewsItem(raw);
            entries.push({
              kind: "announcement",
              id: announcement.id,
              title: announcement.title,
              body: announcement.body,
            });
          }
        } catch (error) {
          log("DEBUG", `search_course: announcements fetch failed for course ${courseId}`, error);
          notes.push(`announcements: ${describeFailure(error)}`);
        }

        // Discussions: forums and their topics
        try {
          const forums = await fetchForums(apiClient, courseId);
          for (const forum of forums) {
            entries.push({
              kind: "discussion",
              id: forum.ForumId,
              title: forum.Name,
              body: forum.Description?.Text ?? "",
            });

            try {
              const topics = await fetchForumTopics(apiClient, courseId, forum.ForumId);
              for (const topic of topics) {
                entries.push({
                  kind: "discussion",
                  id: topic.TopicId,
                  title: topic.Name,
                  body: topic.Description?.Text ?? "",
                  moduleTitle: forum.Name,
                });
              }
            } catch (error) {
              // One forum's topics failing (e.g. no access) shouldn't drop
              // every other forum — same graceful-degradation rule
              // get_discussions already follows for this exact call.
              log("DEBUG", `search_course: topics fetch failed for forum ${forum.ForumId}`, error);
            }
          }
        } catch (error) {
          log("DEBUG", `search_course: discussions fetch failed for course ${courseId}`, error);
          notes.push(`discussions: ${describeFailure(error)}`);
        }

        const results = rankEntries(entries, query, limit);

        log(
          "INFO",
          `search_course: ${results.length} matches for "${query}" in course ${courseId}`
        );

        return toolResponse({
          courseId,
          query,
          results,
          ...(notes.length > 0 ? { note: `Could not search: ${notes.join("; ")}` } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

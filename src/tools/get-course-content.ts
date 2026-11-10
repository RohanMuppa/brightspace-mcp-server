/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetCourseContentSchema } from "./schemas.js";
import { toolResponse, sanitizeError, isAuthUnavailable } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { matchesModifiedSince } from "../utils/modified-since.js";
import { log } from "../utils/logger.js";
import { extractCourseFilePaths } from "../utils/course-files.js";
import { contentAvailability, type ContentAvailability } from "./content-availability.js";

// D2L Content API response type
export interface ContentObject {
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Type: number; // 0 = Module, 1 = Topic
  Description: { Text: string; Html: string } | null;
  ModuleStartDate: string | null;
  ModuleEndDate: string | null;
  ModuleDueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  LastModifiedDate: string | null;
  // Module-specific
  Structure?: ContentObject[];
  // Topic-specific
  TopicType?: number; // 1=File, 2=Link/URL, 3=ExternalLink, etc.
  Url?: string;
  TypeIdentifier?: string;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
}

// Progress tracking
interface ContentProgress {
  UserId: number;
  ContentObjectId: number;
  IsRead: boolean;
  DateCompleted: string | null;
}

// Topic type mapping
const TOPIC_TYPE_MAP: Record<number, string> = {
  1: 'file',
  2: 'link',
  3: 'link',  // External link
};

/**
 * Check if a content item matches the specified type filter.
 */
function matchesTypeFilter(item: ContentObject, filter: string): boolean {
  switch (filter) {
    case 'file':
      return item.TopicType === 1;
    case 'link':
      return item.TopicType === 2 || item.TopicType === 3;
    case 'html':
      return !!(item.Description?.Html) && item.TopicType !== 1;
    case 'video':
      return (item.TopicType === 2 || item.TopicType === 3) &&
        /youtube|vimeo|kaltura|video/i.test(item.Url ?? '');
    default:
      return true;
  }
}

/**
 * Fetch the root content modules for a course. Shared with search_course so
 * both tools walk the exact same tree (and share its cache entry) instead of
 * each hand-rolling the `/content/root/` call.
 */
export async function fetchRootContent(
  apiClient: D2LApiClient,
  courseId: number
): Promise<ContentObject[]> {
  return apiClient.get<ContentObject[]>(
    apiClient.le(courseId, '/content/root/'),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
}

/** Why a module's children are missing from the tree. */
export interface ChildrenUnavailable {
  status: number | null;
  reason: string;
}

/**
 * Fetch a single module's structure, or say why it couldn't be read (locked
 * module, transient error, an answer that is not a list) so the caller can
 * fall back to whatever structure the parent listing already embedded. A
 * pending or expired sign-in is rethrown: it fails every module the same way,
 * and must fail the call so the user is told to sign in, not shown a course
 * whose every module looks empty.
 */
export async function fetchModuleStructure(
  apiClient: D2LApiClient,
  courseId: number,
  moduleId: number
): Promise<ContentObject[] | ChildrenUnavailable> {
  let structure: unknown;
  try {
    structure = await apiClient.get<ContentObject[]>(
      apiClient.le(courseId, `/content/modules/${moduleId}/structure/`),
      { ttl: DEFAULT_CACHE_TTLS.courseContent }
    );
  } catch (error) {
    if (isAuthUnavailable(error)) throw error;
    log('DEBUG', `Failed to fetch children for module ${moduleId}: falling back to the embedded structure`, error);
    const status = typeof (error as any)?.status === 'number' ? (error as any).status : null;
    return {
      status,
      reason: status === 403
        ? "Brightspace refused this account's request for this module's contents. It may hold items; open the module in a browser to see what this account can read."
        : `Couldn't read this module's contents${status !== null ? ` (Brightspace answered ${status})` : ''}. It may hold items; try again.`,
    };
  }
  if (Array.isArray(structure)) return structure;
  log('DEBUG', `Module ${moduleId} structure was not a list: falling back to the embedded structure`);
  return {
    status: null,
    reason: "Brightspace answered with something other than a list of this module's contents. It may hold items; try again.",
  };
}

/**
 * How deep the tree builder will descend when the caller names no maxDepth.
 * A module structure that lists itself is a cycle, and without a ceiling the
 * recursion would never come back.
 */
const MAX_CONTENT_DEPTH = 12;

/**
 * Availability fields are additive, matching the isHidden/isLocked convention
 * above: an available item carries none of them (absence = available), and a
 * restricted one omits startDate/endDate when there is no actual bound
 * rather than emitting a null.
 */
function availabilityFields(availability: ContentAvailability): Record<string, unknown> {
  if (availability.isAvailable) return {};
  const { isAvailable, availabilityStatus, availabilityMessage, startDate, endDate } = availability;
  return {
    isAvailable,
    availabilityStatus,
    availabilityMessage,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

/**
 * Recursively build the content tree with progress tracking.
 */
export async function buildContentTree(
  apiClient: D2LApiClient,
  courseId: number,
  modules: ContentObject[],
  progressMap: Map<number, ContentProgress> | null,
  typeFilter: string,
  maxDepth?: number,
  currentDepth: number = 0,
  parentAvailability?: ContentAvailability,
  now = new Date(),
): Promise<any[]> {
  const tree = [];
  const depthLimit = Math.min(maxDepth ?? MAX_CONTENT_DEPTH, MAX_CONTENT_DEPTH);

  for (const item of modules) {
    const availability = contentAvailability(item, now, parentAvailability);
    if (item.Type === 0) {
      // Module: fetch children recursively (unless the depth limit is reached)
      let processedChildren: any[] = [];
      let childrenUnavailable: ChildrenUnavailable | undefined;

      if (currentDepth < depthLimit) {
        // The parent listing already embeds this module's immediate children
        // in Structure. The dedicated endpoint is still asked first because it
        // is the authoritative copy, but a module whose structure call fails —
        // or answers with something that is not an array — must fall back to
        // what the parent already handed us. Falling through to an empty list
        // made a locked or erroring module look like an empty one, and under a
        // typeFilter it dropped the module from the tree with no trace.
        // When neither copy is readable, the module's children are reported
        // as null with a reason, never as [], so it can't pass for an empty
        // module, and the module is kept under any typeFilter because nothing
        // says it holds no matching items.
        const structure = await fetchModuleStructure(apiClient, courseId, item.Id);
        let children: ContentObject[] | null = null;
        if (Array.isArray(structure)) {
          children = structure;
        } else if (Array.isArray(item.Structure)) {
          children = item.Structure;
        } else {
          childrenUnavailable = structure;
        }

        if (children) {
          processedChildren = await buildContentTree(
            apiClient, courseId, children, progressMap, typeFilter, maxDepth, currentDepth + 1, availability, now
          );
        }
      } else if (currentDepth >= MAX_CONTENT_DEPTH) {
        log('DEBUG', `Content depth ceiling of ${MAX_CONTENT_DEPTH} reached at module ${item.Id}: not descending further`);
      }

      // Only include module if it has matching children (or filter is 'all')
      if (typeFilter === 'all' || processedChildren.length > 0 || childrenUnavailable) {
        const courseFiles = item.Description?.Html ? extractCourseFilePaths(item.Description.Html, courseId, apiClient.origin) : [];
        tree.push({
          type: 'module',
          id: item.Id,
          title: item.Title,
          description: item.Description?.Html?.trim()
            ? convertHtmlToMarkdown(item.Description.Html).markdown
            : item.Description?.Text ?? null,
          ...(courseFiles.length > 0 ? { courseFiles } : {}),
          ...(item.ModuleDueDate ? { dueDate: item.ModuleDueDate } : {}),
          ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
          ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
          ...availabilityFields(availability),
          lastModified: item.LastModifiedDate ?? null,
          ...(childrenUnavailable ? { childrenUnavailable } : {}),
          children: childrenUnavailable ? null : processedChildren,
        });
      }
    } else if (item.Type === 1) {
      // Topic — process based on TopicType
      const topicType = TOPIC_TYPE_MAP[item.TopicType ?? 0] ?? 'other';

      // Apply type filter
      if (typeFilter !== 'all' && !matchesTypeFilter(item, typeFilter)) {
        continue;
      }

      // A null map means progress couldn't be read: completion is unknown,
      // not false, so a failed read can't pass for "nothing completed".
      const topicProgress = progressMap?.get(item.Id);

      const topic: any = {
        type: 'topic',
        topicType,
        id: item.Id,
        title: item.Title,
        ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
        ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
        ...availabilityFields(availability),
        ...(item.DueDate ? { dueDate: item.DueDate } : {}),
        lastModified: item.LastModifiedDate ?? null,
        isCompleted: progressMap === null ? null : topicProgress?.IsRead ?? false,
        ...(topicProgress?.DateCompleted ? { completedDate: topicProgress.DateCompleted } : {}),
      };

      // Add type-specific content
      if (item.TopicType === 1) {
        // File topic — include description
        topic.description = item.Description?.Text ?? null;
        topic.topicId = item.Id; // Useful for download_file tool
      } else if (item.TopicType === 2 || item.TopicType === 3) {
        // Link topic — include URL
        topic.url = item.Url ?? null;
      }

      // An embedded video (D2L's ContentService type) has no file behind it.
      // Said outright so it is not taken for a file that is missing.
      if (typeof item.TypeIdentifier === 'string' && item.TypeIdentifier.toLowerCase() === 'contentservice') {
        topic.embeddedMedia = true;
        topic.note = 'Embedded media: download_file cannot fetch it. Open it in Brightspace, or use get_video_transcript for its transcript.';
      }

      // HTML content — include body converted to markdown
      if (item.Description?.Html) {
        topic.content = convertHtmlToMarkdown(item.Description.Html).markdown;
      }

      tree.push(topic);
    }
  }

  return tree;
}

/**
 * Filter a content tree to items modified at or after cutoff.
 *
 * A module is kept when its own timestamp matches OR any descendant matched
 * (even with zero matching children after recursion) — a matched topic with
 * no surrounding module would be a result with no context, which is the
 * failure mode #34 called out.
 */
function filterTreeByModifiedSince(tree: any[], cutoff: Date): any[] {
  const result: any[] = [];
  for (const item of tree) {
    if (item.type === 'topic') {
      if (matchesModifiedSince(item.lastModified, cutoff)) {
        result.push(item);
      }
    } else if (item.type === 'module') {
      // A module whose children couldn't be read stays in, children null:
      // nothing says none of them changed since the cutoff.
      if (item.childrenUnavailable) {
        result.push(item);
        continue;
      }
      const filteredChildren = filterTreeByModifiedSince(item.children ?? [], cutoff);
      const moduleMatches = matchesModifiedSince(item.lastModified, cutoff);
      if (moduleMatches || filteredChildren.length > 0) {
        result.push({ ...item, children: filteredChildren });
      }
    }
  }
  return result;
}

/**
 * Count total topics in tree (for summary stats).
 */
function countTopics(tree: any[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === 'topic') {
      count++;
    } else if (item.type === 'module' && item.children) {
      count += countTopics(item.children);
    }
  }
  return count;
}

/**
 * Count total modules in tree (for summary stats).
 */
function countModules(tree: any[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === 'module') {
      count++;
      if (item.children) {
        count += countModules(item.children);
      }
    }
  }
  return count;
}

/**
 * Count modules whose children couldn't be read (for the notice).
 */
export function countUnreadableModules(tree: any[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === 'module') {
      if (item.childrenUnavailable) count++;
      if (item.children) count += countUnreadableModules(item.children);
    }
  }
  return count;
}

/**
 * Register get_course_content tool
 */
export function registerGetCourseContent(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_course_content",
    {
      title: "Get Course Content",
      annotations: { readOnlyHint: true },
      description:
        "Fetch the content tree for a course showing modules, topics, files, and links. Use this when the user asks about course materials, lecture slides, uploaded files, content structure, or what's in a course module. Use moduleTitle to filter to a specific module (e.g. 'Labs', 'Staff', 'Homeworks') instead of fetching the entire tree. Use maxDepth to limit recursion depth for a table-of-contents view. A module or topic that isn't currently available carries isAvailable/availabilityStatus/availabilityMessage (and startDate/endDate when known) explaining why; absence of these fields means it's available now.",
      inputSchema: GetCourseContentSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_course_content tool called", { args });

        // Parse and validate input
        const { courseId, typeFilter = 'all', moduleTitle, maxDepth, modifiedSince } = GetCourseContentSchema.parse(args);

        // Fetch root modules
        let rootModules = await fetchRootContent(apiClient, courseId);

        // Filter root modules by title if specified
        if (moduleTitle) {
          const searchTerm = moduleTitle.toLowerCase();
          rootModules = rootModules.filter(m =>
            m.Title.toLowerCase().includes(searchTerm)
          );
        }

        // Fetch user progress for the course (graceful degradation). 403/404
        // means this course has no progress data for the user. Any other
        // failure leaves completion unknown, so the map stays null and every
        // topic reports isCompleted: null rather than false.
        let progressMap: Map<number, ContentProgress> | null = new Map();
        try {
          const progressArray = await apiClient.get<ContentProgress[]>(
            apiClient.le(courseId, '/content/userprogress/'),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
          for (const p of Array.isArray(progressArray) ? progressArray : []) {
            progressMap.set(p.ContentObjectId, p);
          }
        } catch (error: any) {
          if (isAuthUnavailable(error)) throw error;
          if (error?.status !== 404 && error?.status !== 403) {
            log('DEBUG', `Failed to fetch progress for course ${courseId}`, error);
            progressMap = null;
          }
        }

        // Recursively build content tree
        let contentTree = await buildContentTree(
          apiClient,
          courseId,
          rootModules,
          progressMap,
          typeFilter,
          maxDepth
        );

        // Apply modifiedSince filter, if requested, after the tree is built:
        // a module's own timestamp may not change when a child topic does, so
        // filtering has to see the whole tree to know which modules to keep.
        let filteredOut = 0;
        if (modifiedSince) {
          const topicCountBeforeFilter = countTopics(contentTree);
          const cutoff = new Date(modifiedSince);
          contentTree = filterTreeByModifiedSince(contentTree, cutoff);
          filteredOut = topicCountBeforeFilter - countTopics(contentTree);
        }

        const topicCount = countTopics(contentTree);
        const moduleCount = countModules(contentTree);

        const unreadable = countUnreadableModules(contentTree);

        log("INFO", `get_course_content: Retrieved ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})${unreadable > 0 ? `, ${unreadable} module(s) unreadable` : ""}`);

        return toolResponse({
          courseId,
          typeFilter,
          contentTree,
          topicCount,
          moduleCount,
          ...(modifiedSince ? { modifiedSince, returned: topicCount, filteredOut } : {}),
          ...(progressMap === null
            ? {
                progressUnavailable:
                  "Couldn't read this user's completion progress, so every topic has isCompleted null. " +
                  "Do not report topics as not completed; try again later.",
              }
            : {}),
          ...(unreadable > 0
            ? {
                notice:
                  `The contents of ${unreadable} module(s) couldn't be read; they have children null and a ` +
                  "childrenUnavailable reason. topicCount leaves out whatever they hold. Do not report " +
                  "those modules as empty.",
              }
            : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

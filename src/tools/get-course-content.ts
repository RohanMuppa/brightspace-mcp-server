/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetCourseContentSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L Content API response type
interface ContentObject {
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
 * How deep the tree builder will descend when the caller names no maxDepth.
 * A module structure that lists itself is a cycle, and without a ceiling the
 * recursion would never come back.
 */
const MAX_CONTENT_DEPTH = 12;

/**
 * Recursively build the content tree with progress tracking.
 */
async function buildContentTree(
  apiClient: D2LApiClient,
  courseId: number,
  modules: ContentObject[],
  progressMap: Map<number, ContentProgress>,
  typeFilter: string,
  maxDepth?: number,
  currentDepth: number = 0,
): Promise<any[]> {
  const tree = [];
  const depthLimit = Math.min(maxDepth ?? MAX_CONTENT_DEPTH, MAX_CONTENT_DEPTH);

  for (const item of modules) {
    if (item.Type === 0) {
      // Module: fetch children recursively (unless the depth limit is reached)
      let processedChildren: any[] = [];

      if (currentDepth < depthLimit) {
        let children: ContentObject[] = [];
        try {
          children = await apiClient.get<ContentObject[]>(
            apiClient.le(courseId, `/content/modules/${item.Id}/structure/`),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
        } catch (e) {
          log('DEBUG', `Failed to fetch children for module ${item.Id}: skipping`);
        }

        processedChildren = await buildContentTree(
          apiClient, courseId, children, progressMap, typeFilter, maxDepth, currentDepth + 1
        );
      } else if (currentDepth >= MAX_CONTENT_DEPTH) {
        log('DEBUG', `Content depth ceiling of ${MAX_CONTENT_DEPTH} reached at module ${item.Id}: not descending further`);
      }

      // Only include module if it has matching children (or filter is 'all')
      if (typeFilter === 'all' || processedChildren.length > 0) {
        tree.push({
          type: 'module',
          id: item.Id,
          title: item.Title,
          description: item.Description?.Text ?? null,
          dueDate: item.ModuleDueDate ?? null,
          isHidden: item.IsHidden,
          isLocked: item.IsLocked,
          children: processedChildren,
        });
      }
    } else if (item.Type === 1) {
      // Topic — process based on TopicType
      const topicType = TOPIC_TYPE_MAP[item.TopicType ?? 0] ?? 'other';

      // Apply type filter
      if (typeFilter !== 'all' && !matchesTypeFilter(item, typeFilter)) {
        continue;
      }

      const topicProgress = progressMap.get(item.Id);

      const topic: any = {
        type: 'topic',
        topicType,
        id: item.Id,
        title: item.Title,
        isHidden: item.IsHidden,
        isLocked: item.IsLocked,
        dueDate: item.DueDate ?? null,
        isCompleted: topicProgress?.IsRead ?? false,
        completedDate: topicProgress?.DateCompleted ?? null,
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

      // HTML content — include body converted to markdown
      if (item.Description?.Html) {
        topic.content = convertHtmlToMarkdown(item.Description.Html);
      }

      tree.push(topic);
    }
  }

  return tree;
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
      description:
        "Fetch the content tree for a course showing modules, topics, files, and links. Use this when the user asks about course materials, lecture slides, uploaded files, content structure, or what's in a course module. Use moduleTitle to filter to a specific module (e.g. 'Labs', 'Staff', 'Homeworks') instead of fetching the entire tree. Use maxDepth to limit recursion depth for a table-of-contents view.",
      inputSchema: GetCourseContentSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_course_content tool called", { args });

        // Parse and validate input
        const { courseId, typeFilter = 'all', moduleTitle, maxDepth } = GetCourseContentSchema.parse(args);

        // Fetch root modules
        let rootModules = await apiClient.get<ContentObject[]>(
          apiClient.le(courseId, '/content/root/'),
          { ttl: DEFAULT_CACHE_TTLS.courseContent }
        );

        // Filter root modules by title if specified
        if (moduleTitle) {
          const searchTerm = moduleTitle.toLowerCase();
          rootModules = rootModules.filter(m =>
            m.Title.toLowerCase().includes(searchTerm)
          );
        }

        // Fetch user progress for the course (graceful degradation)
        let progressArray: ContentProgress[] = [];
        try {
          progressArray = await apiClient.get<ContentProgress[]>(
            apiClient.le(courseId, '/content/userprogress/'),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
        } catch (error: any) {
          // 404/403 means no progress data available - not an error
          if (error?.status !== 404 && error?.status !== 403) {
            log('DEBUG', `Failed to fetch progress for course ${courseId}`, error);
          }
        }

        // Build progress map for O(1) lookups
        const progressMap = new Map<number, ContentProgress>();
        for (const p of progressArray) {
          progressMap.set(p.ContentObjectId, p);
        }

        // Recursively build content tree
        const contentTree = await buildContentTree(
          apiClient,
          courseId,
          rootModules,
          progressMap,
          typeFilter,
          maxDepth
        );

        const topicCount = countTopics(contentTree);
        const moduleCount = countModules(contentTree);

        log("INFO", `get_course_content: Retrieved ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})`);

        return toolResponse({
          courseId,
          typeFilter,
          contentTree,
          topicCount,
          moduleCount,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

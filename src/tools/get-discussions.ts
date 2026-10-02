/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetDiscussionsSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L Discussion API response types
export interface D2LForum {
  ForumId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymous: boolean;
  RequiresApproval: boolean;
}

export interface D2LTopic {
  ForumId: number;
  TopicId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymousPosts: boolean;
  MustPostToParticipate: boolean;
  RequiresApproval: boolean;
  ScoreOutOf: number | null;
}

interface D2LPost {
  ForumId: number;
  TopicId: number;
  PostId: number;
  ThreadId: number;
  ParentPostId: number | null;
  Subject: string;
  Message: { Text: string; Html: string };
  PostingUserId: number | null;
  PostingUserDisplayName: string;
  DatePosted: string;
  IsAnonymous: boolean;
  IsDeleted: boolean;
  LastEditedDate: string | null;
  ReplyPostIds: number[];
  WordCount: number;
  AttachmentCount: number;
  IsRead: boolean;
}

/**
 * Fetch a course's discussion forums. Shared with search_course so both
 * tools hit the same endpoint (and cache entry) instead of duplicating it.
 */
export async function fetchForums(
  apiClient: D2LApiClient,
  courseId: number
): Promise<D2LForum[]> {
  const forumsPath = apiClient.le(courseId, "/discussions/forums/");
  return apiClient.get<D2LForum[]>(forumsPath, {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });
}

/**
 * Fetch the topics for a single forum. Shared with search_course, same
 * reasoning as fetchForums above.
 */
export async function fetchForumTopics(
  apiClient: D2LApiClient,
  courseId: number,
  forumId: number
): Promise<D2LTopic[]> {
  const topicsPath = apiClient.le(
    courseId,
    `/discussions/forums/${forumId}/topics/`
  );
  return apiClient.get<D2LTopic[]>(topicsPath, {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });
}

/**
 * Register get_discussions tool
 */
export function registerGetDiscussions(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_discussions",
    {
      title: "Get Discussions",
      description:
        "Fetch discussion board content for a course including forums, topics, and posts. Use this when the user asks about discussion boards, forum posts, class discussions, or wants to see what's been posted. Provide just courseId to list all forums and their topics. Add forumId to get topics and posts for a specific forum. Add both forumId and topicId to get all posts in a specific discussion topic.",
      inputSchema: GetDiscussionsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_discussions tool called", { args });

        const { courseId, forumId, topicId } = GetDiscussionsSchema.parse(args);

        // topicId requires forumId
        if (topicId !== undefined && forumId === undefined) {
          return errorResponse(
            "topicId requires forumId. Provide both forumId and topicId to get posts for a specific topic."
          );
        }

        // Specific topic — get posts
        if (forumId !== undefined && topicId !== undefined) {
          return await getTopicPosts(apiClient, courseId, forumId, topicId);
        }

        // Specific forum — get its topics + posts
        if (forumId !== undefined) {
          return await getForumDetail(apiClient, courseId, forumId);
        }

        // All forums overview
        return await getForumsOverview(apiClient, courseId);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

/**
 * Get all forums for a course with their topics (no posts).
 */
async function getForumsOverview(
  apiClient: D2LApiClient,
  courseId: number
): Promise<any> {
  const forums = await fetchForums(apiClient, courseId);

  const result = [];

  for (const forum of forums) {
    // Fetch topics for each forum
    let topics: D2LTopic[] = [];
    try {
      topics = await fetchForumTopics(apiClient, courseId, forum.ForumId);
    } catch (error: any) {
      if (error?.status === 403) {
        log("DEBUG", `No access to topics for forum ${forum.ForumId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch topics for forum ${forum.ForumId}`, error);
      }
    }

    result.push({
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
      topics: topics.map((t) => ({
        topicId: t.TopicId,
        forumId: t.ForumId,
        name: t.Name,
        description: t.Description?.Text ?? null,
        dueDate: t.DueDate,
        isLocked: t.IsLocked,
        isHidden: t.IsHidden,
        mustPostToParticipate: t.MustPostToParticipate,
        scoreOutOf: t.ScoreOutOf,
      })),
    });
  }

  log(
    "INFO",
    `get_discussions: Retrieved ${forums.length} forums for course ${courseId}`
  );

  return toolResponse({
    courseId,
    forumCount: result.length,
    forums: result,
  });
}

/**
 * Get a specific forum with its topics and posts.
 */
async function getForumDetail(
  apiClient: D2LApiClient,
  courseId: number,
  forumId: number
): Promise<any> {
  // Fetch forum info
  const forumPath = apiClient.le(
    courseId,
    `/discussions/forums/${forumId}`
  );
  const forum = await apiClient.get<D2LForum>(forumPath, {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });

  // Fetch topics
  const topicsPath = apiClient.le(
    courseId,
    `/discussions/forums/${forumId}/topics/`
  );
  const topics = await apiClient.get<D2LTopic[]>(topicsPath, {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });

  // Fetch posts for each topic
  const topicsWithPosts = [];
  for (const topic of topics) {
    let posts: D2LPost[] = [];
    try {
      const postsPath = apiClient.le(
        courseId,
        `/discussions/forums/${forumId}/topics/${topic.TopicId}/posts/`
      );
      posts = await apiClient.get<D2LPost[]>(postsPath, {
        ttl: DEFAULT_CACHE_TTLS.announcements,
      });
    } catch (error: any) {
      if (error?.status === 403) {
        log("DEBUG", `No access to posts for topic ${topic.TopicId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch posts for topic ${topic.TopicId}`, error);
      }
    }

    topicsWithPosts.push({
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html
        ? convertHtmlToMarkdown(topic.Description.Html).markdown
        : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
      postCount: posts.length,
      posts: formatPosts(posts),
    });
  }

  log(
    "INFO",
    `get_discussions: Retrieved forum ${forumId} with ${topics.length} topics for course ${courseId}`
  );

  return toolResponse({
    courseId,
    forum: {
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
    },
    topicCount: topicsWithPosts.length,
    topics: topicsWithPosts,
  });
}

/**
 * Get all posts for a specific topic.
 */
async function getTopicPosts(
  apiClient: D2LApiClient,
  courseId: number,
  forumId: number,
  topicId: number
): Promise<any> {
  // Fetch topic info
  const topicPath = apiClient.le(
    courseId,
    `/discussions/forums/${forumId}/topics/${topicId}`
  );
  const topic = await apiClient.get<D2LTopic>(topicPath, {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });

  // Fetch posts
  const postsPath = apiClient.le(
    courseId,
    `/discussions/forums/${forumId}/topics/${topicId}/posts/`
  );
  const posts = await apiClient.get<D2LPost[]>(postsPath, {
    ttl: DEFAULT_CACHE_TTLS.announcements,
  });

  log(
    "INFO",
    `get_discussions: Retrieved ${posts.length} posts for topic ${topicId} in forum ${forumId}`
  );

  return toolResponse({
    courseId,
    forumId,
    topic: {
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html
        ? convertHtmlToMarkdown(topic.Description.Html).markdown
        : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
    },
    postCount: posts.length,
    posts: formatPosts(posts),
  });
}

/**
 * Format posts into a clean thread structure.
 */
function formatPosts(posts: D2LPost[]): any[] {
  return posts
    .filter((p) => !p.IsDeleted)
    .map((p) => ({
      postId: p.PostId,
      threadId: p.ThreadId,
      parentPostId: p.ParentPostId,
      subject: p.Subject,
      message: p.Message?.Html
        ? convertHtmlToMarkdown(p.Message.Html).markdown
        : p.Message?.Text ?? "",
      author: p.IsAnonymous ? "Anonymous" : p.PostingUserDisplayName,
      datePosted: p.DatePosted,
      lastEditedDate: p.LastEditedDate,
      replyCount: p.ReplyPostIds?.length ?? 0,
      wordCount: p.WordCount,
      attachmentCount: p.AttachmentCount,
      isRead: p.IsRead,
    }))
    .sort(
      (a, b) =>
        new Date(a.datePosted).getTime() - new Date(b.datePosted).getTime()
    );
}

/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetVideoTranscriptSchema } from "./schemas.js";
import { toolResponse, errorResponse, sanitizeError } from "./tool-helpers.js";
import { cuesToText, paginateText } from "../utils/transcript/captions.js";
import {
  detectVideoPlatform,
  extractKalturaIds,
  extractYouTubeVideoId,
  type VideoPlatform,
} from "../utils/transcript/platform.js";
import { getKalturaTranscript } from "../utils/transcript/kaltura.js";
import { getYouTubeTranscript } from "../utils/transcript/youtube.js";
import { NoTranscriptError, TranscriptFetchError } from "../utils/transcript/errors.js";
import type { FetchLike, TranscriptResult } from "../utils/transcript/types.js";
import { log } from "../utils/logger.js";

interface ContentTopic {
  Id: number;
  Title: string;
  Url?: string | null;
}

const UNSUPPORTED_PLATFORM_LABEL: Partial<Record<VideoPlatform, string>> = {
  panopto: "Panopto",
  yuja: "YuJa",
  echo360: "Echo360",
  vimeo: "Vimeo",
};

async function resolveVideoUrl(
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number
): Promise<{ url: string } | { error: string }> {
  const topic = await apiClient.get<ContentTopic>(
    apiClient.le(courseId, `/content/topics/${topicId}`),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
  if (!topic.Url) {
    return {
      error:
        `Content topic "${topic.Title}" (id ${topicId}) has no URL Brightspace can resolve to a video. ` +
        "This is common for audio or embedded objects with no direct link. Open it in Brightspace directly.",
    };
  }
  return { url: topic.Url };
}

async function fetchTranscript(
  platform: VideoPlatform,
  videoUrl: string,
  fetchImpl: FetchLike
): Promise<{ result: TranscriptResult } | { unsupported: string } | { noTranscript: string } | { failed: string }> {
  switch (platform) {
    case "kaltura": {
      const ids = extractKalturaIds(videoUrl);
      if (!ids) {
        return {
          failed: `Could not find a Kaltura entry ID and partner ID in this URL: ${videoUrl}`,
        };
      }
      try {
        return { result: await getKalturaTranscript(ids.partnerId, ids.entryId, fetchImpl) };
      } catch (error) {
        if (error instanceof NoTranscriptError) return { noTranscript: error.message };
        if (error instanceof TranscriptFetchError) {
          return {
            failed:
              `${error.message} This can happen when the video needs an authenticated Kaltura ` +
              "session rather than an anonymous one. Open it in Brightspace directly.",
          };
        }
        throw error;
      }
    }
    case "youtube": {
      const videoId = extractYouTubeVideoId(videoUrl);
      if (!videoId) {
        return { failed: `Could not find a YouTube video ID in this URL: ${videoUrl}` };
      }
      try {
        return { result: await getYouTubeTranscript(videoId, fetchImpl) };
      } catch (error) {
        if (error instanceof NoTranscriptError) return { noTranscript: error.message };
        if (error instanceof TranscriptFetchError) return { failed: error.message };
        throw error;
      }
    }
    case "panopto":
    case "yuja":
    case "echo360":
    case "vimeo":
      return {
        unsupported:
          `Video transcripts from ${UNSUPPORTED_PLATFORM_LABEL[platform]} are not supported yet. ` +
          "Open the video in Brightspace directly.",
      };
    default:
      return {
        unsupported:
          `Could not identify a supported video platform for this URL: ${videoUrl}. ` +
          "Open the video in Brightspace directly.",
      };
  }
}

/**
 * Register get_video_transcript tool
 */
export function registerGetVideoTranscript(
  server: McpServer,
  apiClient: D2LApiClient,
  fetchImpl: FetchLike = fetch
): void {
  server.registerTool(
    "get_video_transcript",
    {
      title: "Get Video Transcript",
      description:
        "Read the transcript of a video embedded in course content, such as a recorded lecture or explainer clip. " +
        "Call it with courseId and topicId from get_course_content (typeFilter: 'video' or 'other'), or with videoUrl " +
        "directly if you already have the link. Returns transcript text with timestamps, plus title and duration when " +
        "available. Currently supports Kaltura (e.g. BoilerCast) and YouTube; other platforms return a clear message " +
        "naming what isn't supported yet. Use offset/maxChars to page through a long transcript. Read only — this " +
        "never marks the video as watched.",
      inputSchema: GetVideoTranscriptSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_video_transcript tool called", { args });
        const { courseId, topicId, videoUrl, offset, maxChars } = GetVideoTranscriptSchema.parse(args);

        let resolvedUrl: string;
        if (videoUrl) {
          resolvedUrl = videoUrl;
        } else if (courseId !== undefined && topicId !== undefined) {
          const resolved = await resolveVideoUrl(apiClient, courseId, topicId);
          if ("error" in resolved) {
            return toolResponse({ courseId, topicId, hasTranscript: false, message: resolved.error });
          }
          resolvedUrl = resolved.url;
        } else {
          return errorResponse(
            "Provide either videoUrl, or both courseId and topicId to look up the video from course content."
          );
        }

        const platform = detectVideoPlatform(resolvedUrl);
        const outcome = await fetchTranscript(platform, resolvedUrl, fetchImpl);

        if ("unsupported" in outcome) {
          return toolResponse({
            courseId,
            topicId,
            videoUrl: resolvedUrl,
            platform,
            hasTranscript: false,
            message: outcome.unsupported,
          });
        }
        if ("noTranscript" in outcome) {
          return toolResponse({
            courseId,
            topicId,
            videoUrl: resolvedUrl,
            platform,
            hasTranscript: false,
            message: outcome.noTranscript,
          });
        }
        if ("failed" in outcome) {
          return errorResponse(outcome.failed);
        }

        const { result } = outcome;
        const fullText = cuesToText(result.cues);
        const { window, truncated, nextOffset, totalChars } = paginateText(fullText, offset, maxChars);

        log(
          "INFO",
          `get_video_transcript: ${platform} transcript for ${resolvedUrl} (${result.cues.length} cues, ${totalChars} chars)`
        );

        return toolResponse({
          courseId,
          topicId,
          videoUrl: resolvedUrl,
          platform,
          hasTranscript: true,
          title: result.title,
          durationSeconds: result.durationSeconds,
          language: result.language,
          captionFormat: result.format,
          cueCount: result.cues.length,
          transcript: window,
          truncated,
          nextOffset,
          totalChars,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

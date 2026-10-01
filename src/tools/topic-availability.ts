/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { ApiError, DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { contentAvailability, type AvailabilityMetadata, type ContentAvailability } from "./content-availability.js";
import { log } from "../utils/logger.js";

type Metadata = AvailabilityMetadata & { Title?: string; Id?: unknown; TopicId?: unknown; Identifier?: unknown; TopicType?: number; TypeIdentifier?: string };
interface TopicMatch { metadata: Metadata; availability: ContentAvailability }

export interface UnavailableTopic {
  success: false;
  available: false;
  courseId: number;
  topicId: number;
  title?: string;
  reason: Exclude<ContentAvailability["availabilityStatus"], "available">;
  startDate: string | null;
  endDate: string | null;
  message: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function matchesTopic(value: Metadata, topicId: number): boolean {
  return [value.TopicId, value.Identifier, value.Id].some(id =>
    (typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) && Number(id) === topicId
  );
}

/** A bounded iterative traversal also tolerates incomplete TOC responses. */
function findTopic(toc: unknown, topicId: number, now: Date): TopicMatch | null {
  const modules = record(toc)?.Modules;
  if (!Array.isArray(modules)) return null;
  const queue: Array<{ module: unknown; parent?: ContentAvailability }> = modules.map(module => ({ module }));
  const visited = new Set<object>();
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const entry = queue[index];
    const module = record(entry.module);
    if (!module || visited.has(module)) continue;
    visited.add(module);
    const availability = contentAvailability(module, now, entry.parent);
    if (Array.isArray(module.Topics)) {
      for (const raw of module.Topics) {
        const topic = record(raw);
        if (topic && matchesTopic(topic, topicId)) {
          return { metadata: topic, availability: contentAvailability(topic, now, availability) };
        }
      }
    }
    if (Array.isArray(module.Modules)) {
      for (const nested of module.Modules) queue.push({ module: nested, parent: availability });
    }
  }
  return null;
}

/** Explain only restrictions backed by topic/TOC metadata; preserve unexplained download errors. */
export async function checkTopicAvailability(
  client: D2LApiClient,
  courseId: number,
  topicId: number,
  httpStatus: number,
): Promise<UnavailableTopic | null> {
  if (httpStatus !== 403 && httpStatus !== 404) return null;
  const now = new Date();
  let direct: Metadata | null = null;
  try {
    const raw = record(await client.get<unknown>(client.le(courseId, `/content/topics/${topicId}`), {
      ttl: DEFAULT_CACHE_TTLS.courseContent,
    }));
    if (raw && matchesTopic(raw, topicId)) direct = raw;
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) {
      log("DEBUG", "Topic availability lookup failed unexpectedly; preserving the download error", error);
      return null;
    }
  }

  let fromToc: TopicMatch | null = null;
  try {
    const toc = await client.get<unknown>(client.le(courseId, "/content/toc"), { ttl: DEFAULT_CACHE_TTLS.courseContent });
    fromToc = findTopic(toc, topicId, now);
  } catch (error) {
    log("DEBUG", "TOC availability lookup failed; using direct topic metadata if present", error);
  }
  if (!direct && !fromToc) return null;
  const metadata = direct ?? fromToc!.metadata;
  // A link or quiz has no file endpoint even after release. Preserve that
  // failure instead of promising that its file will become downloadable.
  const isNonFile = (item: Metadata | undefined | null): boolean => Boolean(item && (
    item.TopicType === 2 || item.TopicType === 3 ||
    (typeof item.TypeIdentifier === "string" && ["link", "quiz", "discussion", "dropbox", "assignment"].includes(item.TypeIdentifier.toLowerCase()))
  ));
  if (isNonFile(direct) || isNonFile(fromToc?.metadata)) return null;
  const availability = direct ? contentAvailability(direct, now, fromToc?.availability) : fromToc!.availability;
  const title = typeof metadata.Title === "string" ? metadata.Title
    : typeof fromToc?.metadata.Title === "string" ? fromToc.metadata.Title : undefined;
  // Additive only: if the metadata itself says the topic is available, it
  // doesn't explain the download failure — keep the original error instead
  // of manufacturing a misleading "restricted" response.
  if (availability.isAvailable) return null;
  return {
    success: false, available: false, courseId, topicId, ...(title ? { title } : {}),
    reason: availability.availabilityStatus as UnavailableTopic["reason"],
    startDate: availability.startDate, endDate: availability.endDate,
    message: availability.availabilityMessage,
  };
}

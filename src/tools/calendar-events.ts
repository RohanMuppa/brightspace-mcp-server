/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { calendarUrl } from "../utils/deep-links.js";
import type { CourseRef } from "./resolve-courses.js";

/** Calendar.EventDataInfo, trimmed to the fields read here. */
interface EventDataInfo {
  CalendarEventId: number;
  Title: string;
  // Documented as a string; tolerate the rich-text shape other LE areas use.
  Description?: string | { Text?: string; Html?: string } | null;
  StartDateTime: string | null;
  EndDateTime: string | null;
  StartDay?: string | null;
  EndDay?: string | null;
  LocationName?: string | null;
  AssociatedEntity?: {
    AssociatedEntityType: string;
    AssociatedEntityId: number;
  } | null;
}

/**
 * The item a calendar event was generated from. The types an existing tool
 * already reports use that tool's own `type` names, so a caller can match an
 * event to the item it came from.
 */
const ENTITY_TYPES: Record<string, string> = {
  "D2L.LE.Dropbox.Dropbox": "assignment",
  "D2L.LE.Quizzing.Quiz": "quiz",
  "D2L.LE.Discussions.DiscussionTopic": "discussion",
  "D2L.LE.Discussions.DiscussionForum": "forum",
  "D2L.LE.Content.ContentObject.ModuleCO": "module",
  "D2L.LE.Content.ContentObject.TopicCO": "topic",
  "D2L.LE.Grades.GradeObject": "grade",
  "D2L.LE.Checklist.ChecklistItem": "checklist",
  "D2L.LE.Survey.Survey": "survey",
};

export interface CalendarEvent {
  id: number;
  title: string;
  courseId: number;
  courseName: string | null;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  url: string;
  /** Present when Brightspace generated the event from another item. */
  generatedFrom?: { type: string; id: number };
}

const HOUR_MS = 60 * 60 * 1000;

function descriptionMarkdown(description: EventDataInfo["Description"]): string {
  const html = typeof description === "string" ? description : description?.Html || description?.Text || "";
  return convertHtmlToMarkdown(html).markdown.trim();
}

/** One raw event as a CalendarEvent, or null when it has no start at all. */
function toCalendarEvent(raw: EventDataInfo, baseUrl: string, course: CourseRef): CalendarEvent | null {
  // All-day events carry their dates in StartDay/EndDay instead.
  const start = raw.StartDateTime ?? raw.StartDay ?? null;
  if (!start) return null;

  const end = raw.EndDateTime ?? raw.EndDay ?? null;
  const location = raw.LocationName?.trim();
  const description = descriptionMarkdown(raw.Description);
  const entity = raw.AssociatedEntity;

  return {
    id: raw.CalendarEventId,
    title: raw.Title,
    courseId: course.id,
    courseName: course.name,
    start,
    ...(end ? { end } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    url: calendarUrl(baseUrl, course.id),
    ...(entity
      ? {
          generatedFrom: {
            type: ENTITY_TYPES[entity.AssociatedEntityType] ?? entity.AssociatedEntityType,
            id: entity.AssociatedEntityId,
          },
        }
      : {}),
  };
}

/**
 * Every calendar event in one course that starts inside [from, to] (epoch ms).
 *
 * The request window is widened to whole hours so repeated calls within the
 * cache TTL share one cached response; the exact window is applied here.
 */
export async function fetchCourseCalendarEvents(
  apiClient: D2LApiClient,
  baseUrl: string,
  course: CourseRef,
  from: number,
  to: number
): Promise<CalendarEvent[]> {
  const requestFrom = new Date(Math.floor(from / HOUR_MS) * HOUR_MS).toISOString();
  const requestTo = new Date(Math.ceil(to / HOUR_MS) * HOUR_MS).toISOString();

  const raw = await fetchAllObjects<EventDataInfo>(
    apiClient,
    apiClient.le(
      course.id,
      `/calendar/events/myEvents/?startDateTime=${encodeURIComponent(requestFrom)}&endDateTime=${encodeURIComponent(requestTo)}`
    ),
    { ttl: DEFAULT_CACHE_TTLS.calendar }
  );

  return raw
    .map((event) => toCalendarEvent(event, baseUrl, course))
    .filter((event): event is CalendarEvent => {
      if (!event) return false;
      const start = new Date(event.start).getTime();
      return Number.isFinite(start) && start >= from && start <= to;
    });
}

/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** Release windows shared by content listings and unavailable-file responses. */
export type AvailabilityStatus = "available" | "not_yet_open" | "locked" | "hidden" | "ended";

export interface ContentAvailability {
  isAvailable: boolean;
  availabilityStatus: AvailabilityStatus;
  availabilityMessage: string;
  /** Effective window, including enclosing modules. */
  startDate: string | null;
  endDate: string | null;
}

export interface AvailabilityMetadata {
  IsHidden?: boolean;
  IsLocked?: boolean;
  ModuleStartDate?: string | null;
  ModuleEndDate?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
}

const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function validDate(value: unknown): string | null {
  return typeof value === "string" &&
    ISO_8601_PATTERN.test(value.trim()) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function limitDate(own: string | null, parent: string | null, latest: boolean): string | null {
  if (!own) return parent;
  if (!parent) return own;
  return (Date.parse(own) > Date.parse(parent)) === latest ? own : parent;
}

/** Dates explain a scheduled lock more precisely than the generic IsLocked flag. */
export function contentAvailability(
  item: AvailabilityMetadata,
  now = new Date(),
  parent?: ContentAvailability,
): ContentAvailability {
  const ownStart = validDate(item.ModuleStartDate) ?? validDate(item.StartDate) ?? validDate(item.StartDateTime);
  const ownEnd = validDate(item.ModuleEndDate) ?? validDate(item.EndDate) ?? validDate(item.EndDateTime);
  const startDate = limitDate(ownStart, parent?.startDate ?? null, true);
  const endDate = limitDate(ownEnd, parent?.endDate ?? null, false);
  let availabilityStatus: AvailabilityStatus = "available";
  let availabilityMessage = "Available";
  if (item.IsHidden === true || parent?.availabilityStatus === "hidden") {
    availabilityStatus = "hidden";
    availabilityMessage = "This content is hidden by the instructor.";
  } else if (endDate && Date.parse(endDate) <= now.getTime()) {
    availabilityStatus = "ended";
    availabilityMessage = `This content's availability window has ended (closed at ${endDate}).`;
  } else if (item.IsLocked === true || parent?.availabilityStatus === "locked") {
    availabilityStatus = "locked";
    availabilityMessage = "This content is locked by the instructor or an enclosing module.";
  } else if (startDate && endDate && Date.parse(startDate) >= Date.parse(endDate)) {
    availabilityStatus = "locked";
    availabilityMessage = "The content and its enclosing modules have no overlapping availability window.";
  } else if (startDate && Date.parse(startDate) > now.getTime()) {
    availabilityStatus = "not_yet_open";
    availabilityMessage = `This content has not been released by the instructor yet (available from ${startDate}).`;
  }
  return { isAvailable: availabilityStatus === "available", availabilityStatus, availabilityMessage, startDate, endDate };
}

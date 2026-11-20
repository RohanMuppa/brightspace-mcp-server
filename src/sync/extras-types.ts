/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * What the extra phases of a full-course sync (assignments, announcements) get
 * from the sync that runs them. They share the Content phase's caps, manifest,
 * dry run, existing-file rules, deadline, cancel and sign-in stop: they only
 * decide what to save and where, and hand each file to `saveFile`.
 */

import type { D2LApiClient } from "../api/index.js";
import type { ExistingMode } from "./course-sync.js";
import type { FeedbackEntry, ManifestEntry, SyncManifest } from "./manifest.js";

export type SaveStatus = "saved" | "skipped" | "planned" | "failed" | "empty" | "notAttempted" | "unavailable" | "duplicate";

export interface SaveSpec {
  /** Folders below the destination, outermost first. Already safe names. */
  segments: string[];
  /** The planned file name. Already a safe single component. */
  name: string;
  /** What this sync saved for the file before: it is found again wherever it ended up. */
  prior?: ManifestEntry;
  /** True when the planned path is another file's, so a free numbered name is used. */
  ownedByOther?: (relPath: string) => boolean;
  /** Request the file. Throws an ApiError for a refusal. */
  open: (signal: AbortSignal) => Promise<{ response: Response } | { unavailable: unknown }>;
  onSaved: (entry: ManifestEntry) => void;
}

export interface SaveOutcome {
  status: SaveStatus;
  /** The path from the destination: the file saved, the file already there, or the planned one. */
  rel: string;
}

export interface TextSpec {
  segments: string[];
  name: string;
  content: string;
  prior?: FeedbackEntry;
  onWritten: (entry: FeedbackEntry) => void;
}

export type TextStatus = "written" | "refreshed" | "unchanged" | "edited" | "skipped" | "planned" | "failed";

export interface PhaseContext {
  apiClient: D2LApiClient;
  courseId: number;
  signal: AbortSignal;
  dryRun: boolean;
  existing: ExistingMode;
  manifest: SyncManifest;
  /** True once the run has a stop reason or the signal aborted. Check before each unit of work. */
  stopped: () => boolean;
  /** For a caught error: true when it is a lost sign-in or a cancel, which the sync has recorded as the stop. */
  handleStop: (error: unknown) => boolean;
  saveFile: (spec: SaveSpec) => Promise<SaveOutcome>;
  saveText: (spec: TextSpec) => Promise<{ status: TextStatus; rel: string }>;
  /** Mark the manifest changed after editing an extras record. */
  touch: () => void;
}

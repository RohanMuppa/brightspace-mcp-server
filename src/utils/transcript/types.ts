/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { CaptionFormat, TranscriptCue } from "./captions.js";

/** What every platform adapter (kaltura.ts, youtube.ts, ...) resolves to on success. */
export interface TranscriptResult {
  cues: TranscriptCue[];
  format: CaptionFormat;
  language: string | null;
  title: string | null;
  durationSeconds: number | null;
}

/** Minimal fetch surface an adapter needs, so tests can inject a stub instead of touching global fetch. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

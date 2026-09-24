/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createRequire } from "node:module";
import type TurndownServiceType from "turndown";

// turndown is CJS and costs ~50ms to import; defer it to first use via
// createRequire so callers keep a synchronous API instead of turning async.
const require = createRequire(import.meta.url);
let turndownService: TurndownServiceType | undefined;

function getTurndownService(): TurndownServiceType {
  if (!turndownService) {
    const TurndownService: typeof TurndownServiceType = require("turndown");
    turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
  }
  return turndownService;
}

/**
 * Convert D2L HTML content to clean markdown.
 * Returns both markdown (for LLM readability) and raw HTML (for fallback).
 *
 * @param html - Raw HTML string from D2L API (e.g., assignment instructions, content topics)
 * @returns Object with both markdown and html representations
 */
export function convertHtmlToMarkdown(
  html: string
): { markdown: string; html: string } {
  // Handle null/empty input
  if (!html || html.trim().length === 0) {
    return { markdown: "", html: "" };
  }

  try {
    const markdown = getTurndownService().turndown(html);
    return { markdown, html };
  } catch (error) {
    // If conversion fails, fallback to raw HTML
    return { markdown: html, html };
  }
}

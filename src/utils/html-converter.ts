/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createRequire } from "node:module";
import type TurndownServiceType from "turndown";
import { stripD2lSessionParams } from "./session-params.js";

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
      // Turndown routes any element with no text (an <object>, say) to the
      // blank rule before the rules above are consulted, so an embedded
      // object has to be recognised here to keep its address.
      blankReplacement: (_content, node) => {
        const el = node as unknown as HTMLElement;
        if (EMBEDDED_TAGS.includes(el.nodeName)) return embeddedLink(el);
        return (node as unknown as { isBlock: boolean }).isBlock ? "\n\n" : "";
      },
    });

    // Turndown has no rule for <script>, <style> or <noscript>, so it falls
    // back to emitting their text: a D2L description carrying an inline
    // stylesheet or an analytics snippet put raw CSS and JavaScript source
    // into the markdown the model reads. None of it is content.
    turndownService.remove(["script", "style", "noscript"]);

    // Turndown has no table rules either, and its fallback treats every cell
    // as a standalone block -- a syllabus grading table came out as a flat
    // run of paragraphs ("Homework", "30%", "Exams", "70%") with nothing
    // left to say which weight belonged to which item. Emit GFM pipe tables
    // so the pairing survives into the markdown a model is asked to read.
    // Rules are registered once here (not at module scope) because the
    // service itself is now lazily constructed on first use.
    turndownService.addRule("tableCell", {
      filter: ["th", "td"],
      replacement: (content) => ` ${cellText(content)} |`,
    });

    turndownService.addRule("tableRow", {
      filter: "tr",
      replacement: (content, node) => {
        const row = `|${content}`;
        const table = closestTable(node as unknown as Node);
        const rows = table
          ? Array.from((table as Element).querySelectorAll("tr")).filter(
              (candidate) => closestTable(candidate as unknown as Node) === table
            )
          : [];
        // GFM needs a delimiter line after the first row, header row or not:
        // without one the whole block renders as a paragraph and the
        // columns are lost again.
        if (rows.length > 0 && rows[0] === (node as unknown as Node)) {
          const columns = cellsOf(node as unknown as Node).length || 1;
          return `\n${row}\n|${" --- |".repeat(columns)}`;
        }
        return `\n${row}`;
      },
    });

    turndownService.addRule("tableSection", {
      filter: ["thead", "tbody", "tfoot"],
      replacement: (content) => content,
    });

    turndownService.addRule("table", {
      filter: "table",
      replacement: (content) => {
        const body = content.trim();
        return body ? `\n\n${body}\n\n` : "";
      },
    });

    // D2L appends per-session query params (d2lSessionVal, d2lSecureSessionVal,
    // a `_` cache-buster) to in-content hrefs. Left alone, the markdown we hand
    // the model echoes a live session token into the chat transcript. These
    // two rules are unshifted ahead of Turndown's built-in link/image rules
    // (addRule always inserts at the front of the rule list), so they run
    // first and the defaults never see the raw attribute.
    turndownService.addRule("linkSessionTokens", {
      filter: (node) => node.nodeName === "A" && !!(node as HTMLElement).getAttribute("href"),
      replacement: (content, node) => {
        const href = (node as HTMLElement).getAttribute("href") ?? "";
        // javascript:/data: hrefs aren't content links; drop the link but
        // keep whatever text was inside it.
        if (isUnsafeHref(href)) return content;
        const cleaned = stripD2lSessionParams(href).replace(/([()])/g, "\\$1");
        const title = (node as HTMLElement).getAttribute("title");
        const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
        return `[${content}](${cleaned}${titlePart})`;
      },
    });

    // Embedded frames and media carry no text, so Turndown dropped them
    // whole: a post whose details sat in an embedded PDF or video read as if
    // that part did not exist. Keep the address as a link so the model can
    // see that something was embedded and where it lives.
    turndownService.addRule("embeddedContent", {
      filter: ["iframe", "object", "embed", "video", "audio"],
      replacement: (_content, node) => embeddedLink(node as HTMLElement),
    });

    turndownService.addRule("imageSessionTokens", {
      filter: "img",
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        const alt = el.getAttribute("alt") ?? "";
        const src = stripD2lSessionParams(el.getAttribute("src") ?? "");
        const title = el.getAttribute("title");
        const titlePart = title ? ` "${title}"` : "";
        return src ? `![${alt}](${src}${titlePart})` : "";
      },
    });
  }
  return turndownService;
}

const EMBEDDED_TAGS = ["IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO"];

/** A link to an embedded frame or media file; empty when it has no usable address. */
function embeddedLink(el: HTMLElement): string {
  const raw = el.getAttribute("src") ?? el.getAttribute("data") ?? "";
  if (!raw.trim() || isUnsafeHref(raw)) return "";
  const label = (el.getAttribute("title") || el.getAttribute("aria-label") || "Embedded content")
    .replace(/[\[\]]/g, "");
  return `[${label}](${stripD2lSessionParams(raw).replace(/([()])/g, "\\$1")})`;
}

/** True for `javascript:`/`data:` hrefs -- never a legitimate content link. */
function isUnsafeHref(href: string): boolean {
  return /^\s*(javascript|data):/i.test(href);
}

/** A cell's text, flattened so one table cell stays one table cell. */
function cellText(content: string): string {
  return content
    .replace(/\|/g, "\\|")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** The nearest enclosing <table>, so a nested table is scoped to itself. */
function closestTable(node: Node): Node | null {
  let current: Node | null = node.parentNode;
  while (current) {
    if (current.nodeName === "TABLE") return current;
    current = current.parentNode;
  }
  return null;
}

/** Direct <th>/<td> children of a row. */
function cellsOf(row: Node): Node[] {
  return Array.from(row.childNodes).filter(
    (child) => child.nodeName === "TH" || child.nodeName === "TD"
  );
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

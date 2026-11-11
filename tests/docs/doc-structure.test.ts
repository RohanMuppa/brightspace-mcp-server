/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Doc structure. Fails `npm run test:run` (and so CI) when the docs stop
 * being something a reader can follow:
 *
 * - a relative link or #anchor points at nothing;
 * - a doc names a src/, tests/, scripts/ or .github/ path that is gone;
 * - a page that is read in full every time grows past its word limit;
 * - a reference or internals page grows a line too long to read;
 * - the version in package.json has no CHANGELOG.md entry;
 * - a page under docs/ is not reachable from AGENTS.md;
 * - CLAUDE.md stops importing AGENTS.md, so agents would get different rules.
 *
 * Why these exist: LLMs.md grew to 13,000 words one reasonable paragraph at
 * a time, with single lines over 4,000 characters, while STABILITY.md and
 * six test files kept citing a section that had been removed. Nothing
 * noticed. Each failure message says what to do instead.
 *
 * tests/docs/doc-coverage.test.ts is the companion: it checks that names in
 * the source appear in the docs. This file checks the docs against themselves.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Pages read in full on every install or every coding session. Words. */
const WORD_LIMITS: Record<string, number> = {
  "LLMs.md": 1400,
  "AGENTS.md": 1100,
  "README.md": 2800,
};

/** The longest line allowed where pages are meant to be scanned. Characters. */
const LINE_LIMIT = 500;
const LINE_LIMITED = (file: string) =>
  file === "LLMs.md" || file === "AGENTS.md" || file.startsWith("docs/reference/") || file.startsWith("docs/internals/");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(ROOT, relative));
}

/** Every Markdown file a reader is sent to: the root pages, docs/ and .github/. */
function docFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relative);
      else if (entry.name.endsWith(".md")) out.push(relative);
    }
  };
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(entry.name);
  }
  visit("docs");
  visit(".github");
  return out.sort();
}

/** The text with fenced code blocks blanked, so examples are not read as links. */
function withoutFences(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

function withoutInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, "``");
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of withoutFences(read(file)).split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

describe("docs can be followed", () => {
  const files = docFiles();

  it("finds the docs it is meant to guard", () => {
    // A broken scan would make every check below pass with nothing to check.
    for (const expected of ["README.md", "LLMs.md", "AGENTS.md", "docs/sign-in.md", "docs/reference/tools.md"]) {
      expect(files).toContain(expected);
    }
  });

  it("has no relative link or #anchor that points at nothing", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = withoutInlineCode(withoutFences(read(file)));
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
        checked += 1;
        const [rawPath, anchor] = target.split("#");
        const targetFile = rawPath === ""
          ? file
          : path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(rawPath)));
        if (!exists(targetFile)) {
          problems.push(`${file}: link to "${target}" but ${targetFile} does not exist`);
          continue;
        }
        if (anchor && targetFile.endsWith(".md") && !anchors(targetFile).has(anchor.toLowerCase())) {
          problems.push(`${file}: link to "${target}" but ${targetFile} has no heading with the anchor #${anchor}`);
        }
      }
    }
    expect(checked, "no relative links found: the link scan is broken").toBeGreaterThan(20);
    expect(problems, "fix the link, or restore the heading it points at").toEqual([]);
  });

  it("names no source, test, script or workflow path that is gone", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of files) {
      // The changelog is history: it may name files that were later removed.
      if (file === "CHANGELOG.md") continue;
      for (const match of withoutFences(read(file)).matchAll(/`((?:src|tests|scripts|\.github)\/[A-Za-z0-9_.\/-]+)`/g)) {
        const named = match[1].replace(/\/$/, "");
        checked += 1;
        if (!exists(named)) problems.push(`${file}: names \`${match[1]}\`, which does not exist`);
      }
    }
    expect(checked, "no paths found: the path scan is broken").toBeGreaterThan(20);
    expect(problems, "update the doc to the file's new name, or remove the mention").toEqual([]);
  });

  it("keeps the pages that are read in full every time short", () => {
    const problems: string[] = [];
    for (const [file, limit] of Object.entries(WORD_LIMITS)) {
      const words = read(file).split(/\s+/).filter(Boolean).length;
      if (words > limit) {
        problems.push(
          `${file} is ${words} words; the limit is ${limit}. Move the detail to docs/reference/ or docs/internals/ and link to it. Do not raise the limit to make room.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps reference and internals pages in lines short enough to scan", () => {
    const problems: string[] = [];
    for (const file of files.filter(LINE_LIMITED)) {
      read(file).split("\n").forEach((line, index) => {
        if (line.length > LINE_LIMIT) {
          problems.push(`${file}:${index + 1} is ${line.length} characters; the limit is ${LINE_LIMIT}. Split it into bullets, one fact each.`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("has a CHANGELOG.md entry for the version in package.json", () => {
    const version = JSON.parse(read("package.json")).version as string;
    const headings = read("CHANGELOG.md").split("\n").filter((line) => line.startsWith("## "));
    const found = headings.some((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
    expect(
      found,
      `CHANGELOG.md has no "## ${version}" section. Add one at the top with a line saying what a user will notice.`,
    ).toBe(true);
  });

  it("can reach every page under docs/ from AGENTS.md", () => {
    const agents = read("AGENTS.md");
    const orphans = files
      .filter((file) => file.startsWith("docs/"))
      .filter((file) => !agents.includes(file) && !agents.includes(`${path.posix.dirname(file)}/\``));
    expect(orphans, "name each new page in AGENTS.md, in the table that says which doc owns what").toEqual([]);
  });

  it("gives every agent the same rules: CLAUDE.md imports AGENTS.md", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
  });
});

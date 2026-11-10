/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Doc coverage. Fails `npm run test:run` (and so CI) when a user-visible name
 * in the source is not written down in the doc that owns it. See CLAUDE.md
 * for the map of which doc owns what.
 *
 * Each list is derived from the source, not copied here:
 *
 * - AuthFailureKind members (src/auth/auth-runner.ts): each must appear as
 *   `name` in docs/sign-in.md or docs/troubleshooting.md.
 * - D2L_* and BRIGHTSPACE_* env vars the server reads (any string or
 *   `env.NAME` access under src/): each must appear in README.md, .env.example
 *   or docs/*.md. Names in ENV_ALLOWLIST are internal and exempt.
 * - SCHOOL_PRESETS keys (imported from src/setup/presets.ts): each must appear
 *   as `--key` in README.md and in LLMs.md.
 * - MCP tools (every `registerTool("name", ...)` call under src/): each must
 *   appear in README.md.
 *
 * The source is parsed with the TypeScript compiler API, so multi-line calls
 * and type unions are read from the syntax tree rather than matched by regex.
 * Each check also asserts it found something, so a parser that silently
 * returned nothing fails the test instead of passing it.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SCHOOL_PRESETS } from "../../src/setup/presets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Env names the server sees but a user never sets. Each needs a reason. */
const ENV_ALLOWLIST: Record<string, string> = {
  D2L_RECOVERY_ID: "internal: the server hands a recovery ID to its own sign-in child for the dev activity log",
  D2L_REEXECED: "internal: set on the re-run of a newer release, so a stale install cannot loop",
};

const ENV_NAME = /^(?:D2L|BRIGHTSPACE)_[A-Z][A-Z0-9_]*$/;
const ENV_MENTION = /\b((?:D2L|BRIGHTSPACE)_[A-Z][A-Z0-9_]*)\b/g;

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function listFiles(relativeDir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (keep(full)) out.push(path.relative(ROOT, full));
    }
  };
  visit(path.join(ROOT, relativeDir));
  return out.sort();
}

function sourceFiles(): string[] {
  return listFiles("src", (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
}

function parse(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true);
}

/** Calls `visit` on every node under `node`, depth first. */
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Every docs/*.md, plus the root files that document settings. */
function docsCorpus(): Record<string, string> {
  const corpus: Record<string, string> = {};
  for (const file of listFiles("docs", (f) => f.endsWith(".md"))) corpus[file] = read(file);
  corpus[".env.example"] = read(".env.example");
  corpus["README.md"] = read("README.md");
  return corpus;
}

function authFailureKinds(): { kind: string; file: string }[] {
  const file = "src/auth/auth-runner.ts";
  const kinds: { kind: string; file: string }[] = [];
  let found = false;
  for (const statement of parse(file).statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== "AuthFailureKind") continue;
    found = true;
    if (!ts.isUnionTypeNode(statement.type)) throw new Error(`AuthFailureKind in ${file} is no longer a string union`);
    for (const member of statement.type.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        kinds.push({ kind: member.literal.text, file });
      }
    }
  }
  if (!found) throw new Error(`AuthFailureKind is not declared in ${file}`);
  return kinds;
}

function registeredTools(): { name: string; file: string }[] {
  const tools: { name: string; file: string }[] = [];
  for (const file of sourceFiles()) {
    walk(parse(file), (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== "registerTool") return;
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        tools.push({ name: first.text, file });
      }
    });
  }
  return tools;
}

/** Env names the server reads: `process.env.X`, `env.X`, `deps.env.X`, or a name written as a string. */
function envVarsRead(): Map<string, string> {
  const found = new Map<string, string>();
  const note = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, file);
  };
  for (const file of sourceFiles()) {
    const source = parse(file);
    walk(source, (node) => {
      if (ts.isPropertyAccessExpression(node) && ENV_NAME.test(node.name.text)) {
        if (/(^|\.)env$/.test(node.expression.getText(source))) note(node.name.text, file);
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        for (const match of node.text.matchAll(ENV_MENTION)) note(match[1], file);
      }
    });
  }
  return found;
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(text);
}

describe("documentation covers the user-visible surface", () => {
  it("documents every AuthFailureKind in sign-in.md or troubleshooting.md", () => {
    const kinds = authFailureKinds();
    expect(kinds.length, "AuthFailureKind parsed to no members").toBeGreaterThan(0);

    const sign = read("docs/sign-in.md");
    const troubleshooting = read("docs/troubleshooting.md");
    const problems = kinds
      .filter(({ kind }) => !sign.includes(`\`${kind}\``) && !troubleshooting.includes(`\`${kind}\``))
      .map(({ kind, file }) =>
        `AuthFailureKind \`${kind}\` (${file}) is missing from docs/sign-in.md and docs/troubleshooting.md`);
    expect(problems).toEqual([]);
  });

  it("documents every D2L_* or BRIGHTSPACE_* env var read in src/ in README.md, .env.example or docs/", () => {
    const envVars = envVarsRead();
    expect(envVars.size, "no env vars found in src/").toBeGreaterThan(0);

    const corpus = docsCorpus();
    const problems: string[] = [];
    for (const [name, file] of [...envVars.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (ENV_ALLOWLIST[name]) continue;
      if (Object.values(corpus).some((text) => containsWord(text, name))) continue;
      problems.push(`env var \`${name}\` (read in ${file}) is missing from README.md, .env.example and docs/*.md`);
    }
    expect(problems).toEqual([]);
  });

  it("names every school preset as --<key> in README.md and LLMs.md", () => {
    const keys = Object.keys(SCHOOL_PRESETS);
    expect(keys.length, "SCHOOL_PRESETS is empty").toBeGreaterThan(0);

    const problems: string[] = [];
    for (const doc of ["README.md", "LLMs.md"]) {
      const text = read(doc);
      for (const key of keys) {
        if (!new RegExp(`--${key}(?![a-z0-9-])`).test(text)) {
          problems.push(`school preset \`--${key}\` (SCHOOL_PRESETS in src/setup/presets.ts) is missing from ${doc}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("documents every registered MCP tool name in README.md", () => {
    const tools = registeredTools();
    expect(tools.length, "no registerTool calls found under src/").toBeGreaterThan(0);

    const readme = read("README.md");
    const problems = tools
      .filter(({ name }) => !containsWord(readme, name))
      .map(({ name, file }) => `MCP tool \`${name}\` (registered in ${file}) is missing from README.md`);
    expect(problems).toEqual([]);
  });
});

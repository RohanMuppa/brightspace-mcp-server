import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const git = vi.hoisted(() => ({
  commands: [] as string[],
  /** Command prefix -> stdout. The longest matching prefix wins. */
  replies: new Map<string, string>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: actual,
    execSync: (command: string) => {
      git.commands.push(command);
      const match = [...git.replies.keys()]
        .filter((prefix) => command.startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0];
      if (match === undefined) throw new Error(`unexpected command: ${command}`);
      return git.replies.get(match)!;
    },
  };
});

const { main, samePath } = await import("../../src/update.js");

/** build/update.js sits one level below the package root, like src/update.ts. */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  git.commands = [];
  git.replies = new Map([
    ["git rev-parse --show-toplevel", projectRoot],
    ["git status --porcelain", ""],
    ["git fetch origin main", ""],
    ["git rev-list --count HEAD..origin/main", "0"],
  ]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("samePath", () => {
  it("matches a directory with itself however it is spelled", () => {
    expect(samePath(projectRoot, path.join(projectRoot, "src", ".."))).toBe(true);
    expect(samePath(projectRoot, path.join(projectRoot, "src"))).toBe(false);
  });
});

describe("update command", () => {
  it("stops without touching a repository that merely contains this install", () => {
    // What an npm-installed copy sees: git answers for the user's own project,
    // several directories above node_modules/brightspace-mcp-server.
    const enclosing = path.resolve(projectRoot, "..");
    git.replies.set("git rev-parse --show-toplevel", enclosing);

    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands).toEqual(["git rev-parse --show-toplevel"]);
    expect(git.commands.some((c) => c.startsWith("git fetch") || c.startsWith("git pull"))).toBe(false);
  });

  it("reports a missing git checkout instead of pulling", () => {
    git.replies = new Map();
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands).toEqual(["git rev-parse --show-toplevel"]);
  });

  it("stops early when the checkout is already current", () => {
    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("git fetch origin main");
    expect(git.commands.some((c) => c.startsWith("git pull"))).toBe(false);
    expect(git.commands.some((c) => c.startsWith("npm "))).toBe(false);
  });

  it("pulls, installs and builds only a real checkout that is behind", () => {
    git.replies.set("git rev-list --count HEAD..origin/main", "2");
    git.replies.set("git log HEAD..origin/main --oneline", "abc feat: one\ndef fix: two");
    git.replies.set("git pull origin main", "");
    git.replies.set("npm install", "");
    git.replies.set("npm run build", "");

    expect(() => main()).not.toThrow();
    expect(git.commands).toEqual([
      "git rev-parse --show-toplevel",
      "git status --porcelain",
      "git fetch origin main",
      "git rev-list --count HEAD..origin/main",
      "git log HEAD..origin/main --oneline",
      "git pull origin main",
      "npm install",
      "npm run build",
    ]);
  });

  it("does not reach the network before the repository is known to be ours", () => {
    git.replies.set("git rev-parse --show-toplevel", path.join(os.tmpdir(), "somewhere-else"));
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands).not.toContain("git fetch origin main");
  });
});

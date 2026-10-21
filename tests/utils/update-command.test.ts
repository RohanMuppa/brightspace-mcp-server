import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const git = vi.hoisted(() => ({
  commands: [] as string[],
  /** Command prefix -> stdout, or an error to throw. The longest matching prefix wins. */
  replies: new Map<string, string | Error>(),
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
      const reply = git.replies.get(match)!;
      if (reply instanceof Error) throw reply;
      return reply;
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

const MARKER_COMMAND = "git rev-parse --git-path brightspace-update-incomplete";
let gitDir: string;
let markerPath: string;

/** What execSync throws when a command exits non-zero with output on stderr. */
function commandFailure(stderr: string): Error {
  return Object.assign(new Error("Command failed"), { stderr });
}

function printed(): string {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ];
  return calls.map((args) => args.join(" ")).join("\n");
}

function behindBy(count: string): void {
  git.replies.set("git rev-list --count HEAD..origin/main", count);
  git.replies.set("git log HEAD..origin/main --oneline", "abc feat: one\ndef fix: two");
  git.replies.set("git pull origin main", "");
  git.replies.set("npm install", "");
  git.replies.set("npm run build", "");
}

beforeEach(() => {
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-update-"));
  markerPath = path.join(gitDir, "brightspace-update-incomplete");
  git.commands = [];
  git.replies = new Map<string, string | Error>([
    ["git rev-parse --show-toplevel", projectRoot],
    ["git status --porcelain", ""],
    ["git fetch origin main", ""],
    [MARKER_COMMAND, markerPath],
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
  fs.rmSync(gitDir, { recursive: true, force: true });
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
    behindBy("2");

    expect(() => main()).not.toThrow();
    expect(git.commands).toEqual([
      "git rev-parse --show-toplevel",
      "git status --porcelain",
      "git fetch origin main",
      MARKER_COMMAND,
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

  it("leaves nothing behind after an update that finishes", () => {
    behindBy("2");
    main();
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(printed()).toContain("Update complete!");
  });

  it("finishes the install and build on the next run after the build failed", () => {
    behindBy("2");
    git.replies.set("npm run build", commandFailure("error TS2307: Cannot find module"));
    expect(() => main()).toThrow(ExitCalled);

    // The pull moved HEAD, so the retry sees nothing new to fetch.
    git.replies.set("git rev-list --count HEAD..origin/main", "0");
    git.replies.set("npm run build", "");
    git.commands = [];
    vi.mocked(console.log).mockClear();

    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("npm install");
    expect(git.commands).toContain("npm run build");
    expect(git.commands.some((c) => c.startsWith("git pull"))).toBe(false);
    expect(printed()).not.toContain("Already up to date");
    expect(printed()).toContain("Update complete!");
  });

  it("finishes the install and build on the next run after the install failed", () => {
    behindBy("2");
    git.replies.set("npm install", commandFailure("npm ERR! EBUSY: resource busy or locked"));
    expect(() => main()).toThrow(ExitCalled);

    git.replies.set("git rev-list --count HEAD..origin/main", "0");
    git.replies.set("npm install", "");
    git.commands = [];

    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("npm install");
    expect(git.commands).toContain("npm run build");
    expect(printed()).not.toContain("Already up to date");
  });

  it("keeps reporting the update as unfinished while the retry still fails", () => {
    behindBy("2");
    git.replies.set("npm run build", commandFailure("error TS1005"));
    expect(() => main()).toThrow(ExitCalled);

    git.replies.set("git rev-list --count HEAD..origin/main", "0");
    expect(() => main()).toThrow(ExitCalled);
    git.replies.set("npm run build", "");
    git.commands = [];
    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("npm run build");
  });

  it("shows why the install failed, without terminal escape codes, and how to retry", () => {
    behindBy("2");
    git.replies.set(
      "npm install",
      commandFailure("\x1b[31mnpm ERR!\x1b[0m code EBUSY\nnpm ERR! EBUSY: resource busy or locked, unlink keyring.node\n"),
    );

    expect(() => main()).toThrow(ExitCalled);
    const output = printed();
    expect(output).toContain("Failed to install dependencies");
    expect(output).toContain("EBUSY: resource busy or locked, unlink keyring.node");
    expect(output).toContain("npm ERR! code EBUSY");
    expect(output).toContain("npm run update");
    expect(output).not.toMatch(/\x1b\[3[0-9]mnpm ERR/);
  });

  it("shows only the end of a long failure log", () => {
    behindBy("2");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    git.replies.set("npm run build", commandFailure(lines.join("\n")));

    expect(() => main()).toThrow(ExitCalled);
    const output = printed();
    expect(output).toContain("line 199");
    expect(output).not.toContain("line 0\n");
    expect(output).not.toMatch(/line 0$/m);
  });
});

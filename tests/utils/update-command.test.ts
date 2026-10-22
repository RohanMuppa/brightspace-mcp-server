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

const { main, samePath, chooseRelease } = await import("../../src/update.js");

/** build/update.js sits one level below the package root, like src/update.ts. */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** The commit npm's `latest` was published from -- behind origin/main. */
const RELEASE_SHA = "4c0ff4c8c5bfb64498166de3ceb411d5e48a6f88";
const NPM_VIEW = "npm view brightspace-mcp-server@latest version gitHead engines --json";

function registry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: "4.1.0", gitHead: RELEASE_SHA, engines: { node: ">=20.0.0" }, ...overrides });
}

const MARKER_COMMAND = "git rev-parse --git-path brightspace-update-incomplete";
let gitDir: string;
let markerPath: string;

/** What execSync throws when a command exits non-zero with output on stderr. */
function commandFailure(stderr: string): Error {
  return Object.assign(new Error("Command failed"), { stderr });
}

/**
 * What execSync throws when `npm run build` fails: tsc prints its errors on
 * stdout, and npm adds only its lifecycle summary on stderr.
 */
function buildFailure(tscOutput: string): Error {
  return Object.assign(new Error("Command failed: npm run build"), {
    stdout: tscOutput,
    stderr: "npm error Lifecycle script `build` failed with error:\nnpm error code 2\n",
  });
}

function printed(): string {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ];
  return calls.map((args) => args.join(" ")).join("\n");
}

function behindBy(count: string): void {
  git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, count);
  git.replies.set(`git log HEAD..${RELEASE_SHA} --oneline`, "abc feat: one\ndef fix: two");
  git.replies.set(`git merge --ff-only ${RELEASE_SHA}`, "");
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
    ["git branch --show-current", "main"],
    [NPM_VIEW, registry()],
    ["git fetch origin main", ""],
    [`git merge-base --is-ancestor ${RELEASE_SHA} origin/main`, ""],
    [`git show ${RELEASE_SHA}:package.json`, JSON.stringify({ version: "4.1.0" })],
    ["git rev-list --count origin/main..HEAD", "0"],
    [`git rev-list --count HEAD..${RELEASE_SHA}`, "0"],
    [MARKER_COMMAND, markerPath],
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

  it("stops early when the checkout already contains the latest release", () => {
    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("git fetch origin main");
    expect(git.commands.some((c) => c.startsWith("git merge --ff-only"))).toBe(false);
    expect(git.commands.some((c) => c.startsWith("npm install") || c.startsWith("npm run"))).toBe(false);
  });

  it("moves to the published npm release, not the unreleased tip of main", () => {
    behindBy("2");

    expect(() => main()).not.toThrow();
    expect(git.commands).toEqual([
      "git rev-parse --show-toplevel",
      "git status --porcelain",
      "git branch --show-current",
      NPM_VIEW,
      "git fetch origin main",
      `git merge-base --is-ancestor ${RELEASE_SHA} origin/main`,
      `git show ${RELEASE_SHA}:package.json`,
      "git rev-list --count origin/main..HEAD",
      MARKER_COMMAND,
      `git rev-list --count HEAD..${RELEASE_SHA}`,
      `git log HEAD..${RELEASE_SHA} --oneline`,
      `git merge --ff-only ${RELEASE_SHA}`,
      "npm install",
      "npm run build",
    ]);
    expect(git.commands.some((c) => c.includes("pull") || c.includes("HEAD..origin/main"))).toBe(false);
  });

  it("changes nothing when the registry cannot be reached", () => {
    git.replies.delete(NPM_VIEW);
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands.some((c) => c.startsWith("git fetch") || c.startsWith("git merge"))).toBe(false);
  });

  it("changes nothing when the release commit is not on origin/main", () => {
    git.replies.delete(`git merge-base --is-ancestor ${RELEASE_SHA} origin/main`);
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands.some((c) => c.startsWith("git merge --ff-only"))).toBe(false);
  });

  it("changes nothing when the release commit carries a different version", () => {
    git.replies.set(`git show ${RELEASE_SHA}:package.json`, JSON.stringify({ version: "5.0.0" }));
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands.some((c) => c.startsWith("git merge --ff-only"))).toBe(false);
  });

  it("changes nothing when the release needs a newer Node.js than this one", () => {
    git.replies.set(NPM_VIEW, registry({ engines: { node: ">=99.0.0" } }));
    expect(() => main()).toThrow(ExitCalled);
    expect(git.commands.some((c) => c.startsWith("git fetch") || c.startsWith("git merge"))).toBe(false);
  });

  it("tells both stdio and shared HTTP users how to load the new build", () => {
    git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, "1");
    git.replies.set(`git log HEAD..${RELEASE_SHA} --oneline`, "abc feat: one");
    git.replies.set(`git merge --ff-only ${RELEASE_SHA}`, "");
    git.replies.set("npm install", "");
    git.replies.set("npm run build", "");

    main();
    const printed = vi.mocked(console.log).mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toMatch(/restart your MCP client/i);
    // A client restart only reconnects to a shared server still running the old build.
    expect(printed).toMatch(/shared HTTP server/i);
    expect(printed).toContain("node build/index.js http");
    expect(printed).toContain("D2L_HTTP_TOKEN");
    // A chat already connected over stdio cannot move onto the shared server mid-session.
    expect(printed).toMatch(/stdio/i);
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
    git.replies.set("npm run build", buildFailure("error TS2307: Cannot find module"));
    expect(() => main()).toThrow(ExitCalled);

    // The pull moved HEAD, so the retry sees nothing new to fetch.
    git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, "0");
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

    git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, "0");
    git.replies.set("npm install", "");
    git.commands = [];

    expect(() => main()).not.toThrow();
    expect(git.commands).toContain("npm install");
    expect(git.commands).toContain("npm run build");
    expect(printed()).not.toContain("Already up to date");
  });

  it("keeps reporting the update as unfinished while the retry still fails", () => {
    behindBy("2");
    git.replies.set("npm run build", buildFailure("error TS1005"));
    expect(() => main()).toThrow(ExitCalled);

    git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, "0");
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

  it("shows the TypeScript error when the build fails", () => {
    behindBy("2");
    git.replies.set(
      "npm run build",
      buildFailure("src/update.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"),
    );

    expect(() => main()).toThrow(ExitCalled);
    const output = printed();
    expect(output).toContain("Build failed");
    expect(output).toContain("src/update.ts(12,5): error TS2322");
    expect(output).toContain("Lifecycle script `build` failed");
  });

  it("shows only the end of a long failure log", () => {
    behindBy("2");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    git.replies.set("npm run build", buildFailure(lines.join("\n")));

    expect(() => main()).toThrow(ExitCalled);
    const output = printed();
    expect(output).toContain("line 199");
    expect(output).not.toContain("line 0\n");
    expect(output).not.toMatch(/line 0$/m);
  });

  describe("refuses to modify a checkout that holds local work", () => {
    /** Anything that rewrites the branch, the working tree or the install. */
    // Commands that change the checkout or the install. git merge-base and
    // npm view only read, so they don't count.
    const mutating = (c: string) =>
      c.startsWith("git pull") ||
      /^git merge(?!-base)/.test(c) ||
      c.startsWith("git rebase") ||
      c.startsWith("git reset") ||
      c.startsWith("git checkout") ||
      c.startsWith("git switch") ||
      /^npm (install|ci|run)\b/.test(c);

    beforeEach(() => {
      // Behind the release, so only the guard stands between the user and an update.
      git.replies.set(`git rev-list --count HEAD..${RELEASE_SHA}`, "2");
      git.replies.set(`git log HEAD..${RELEASE_SHA} --oneline`, "abc feat: one\ndef fix: two");
      git.replies.set(`git merge --ff-only ${RELEASE_SHA}`, "");
      git.replies.set("git pull", "");
      git.replies.set("npm install", "");
      git.replies.set("npm run build", "");
    });

    it("stops when there are uncommitted changes", () => {
      git.replies.set("git status --porcelain", " M src/index.ts");
      expect(() => main()).toThrow(ExitCalled);
      expect(git.commands.filter(mutating)).toEqual([]);
    });

    it("stops when HEAD is detached", () => {
      git.replies.set("git branch --show-current", "");
      expect(() => main()).toThrow(ExitCalled);
      expect(git.commands.filter(mutating)).toEqual([]);
    });

    it("stops on a branch other than main", () => {
      git.replies.set("git branch --show-current", "my-feature");
      expect(() => main()).toThrow(ExitCalled);
      expect(git.commands.filter(mutating)).toEqual([]);
    });

    it("stops when main has local commits origin/main lacks", () => {
      git.replies.set("git rev-list --count origin/main..HEAD", "1");
      expect(() => main()).toThrow(ExitCalled);
      expect(git.commands.filter(mutating)).toEqual([]);
    });

    it("stops without installing when the fast-forward fails", () => {
      // No reply registered: the fake git fails the fast-forward. A pull
      // fallback would still find its reply and be caught below.
      git.replies.delete(`git merge --ff-only ${RELEASE_SHA}`);
      expect(() => main()).toThrow(ExitCalled);
      expect(git.commands).toContain(`git merge --ff-only ${RELEASE_SHA}`);
      expect(git.commands.some((c) => c.startsWith("git pull") || /^npm (install|ci|run)\b/.test(c))).toBe(false);
    });
  });
});

describe("chooseRelease", () => {
  const latest = { version: "4.1.0", gitHead: RELEASE_SHA, engines: { node: ">=20.0.0" } };

  it("targets the published version and the commit it was built from", () => {
    expect(chooseRelease(latest, "v20.11.0")).toEqual({ ok: true, version: "4.1.0", commit: RELEASE_SHA });
  });

  it("accepts a release that states no Node.js requirement", () => {
    expect(chooseRelease({ version: "4.1.0", gitHead: RELEASE_SHA }, "v20.11.0").ok).toBe(true);
  });

  it("refuses a release whose Node.js requirement this runtime does not meet", () => {
    expect(chooseRelease({ ...latest, engines: { node: ">=22.0.0" } }, "v20.11.0").ok).toBe(false);
    expect(chooseRelease({ ...latest, engines: { node: ">=22.0.0" } }, "v22.0.0").ok).toBe(true);
  });

  it("refuses a Node.js requirement it cannot evaluate rather than guessing", () => {
    expect(chooseRelease({ ...latest, engines: { node: "^20 || ^22" } }, "v22.1.0").ok).toBe(false);
  });

  it("refuses a release it cannot tie to a commit", () => {
    expect(chooseRelease({ ...latest, gitHead: undefined }, "v22.1.0").ok).toBe(false);
    expect(chooseRelease({ ...latest, gitHead: "main; rm -rf ~" }, "v22.1.0").ok).toBe(false);
  });

  it("refuses a version that is not a plain stable release", () => {
    expect(chooseRelease({ ...latest, version: "5.0.0-beta.1" }, "v22.1.0").ok).toBe(false);
    expect(chooseRelease(null, "v22.1.0").ok).toBe(false);
  });
});

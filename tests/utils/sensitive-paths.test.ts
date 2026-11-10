import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadRootsFromEnv, sensitiveDestination, sensitiveDestinationMessage } from "../../src/utils/sensitive-paths.js";

const posix = process.platform !== "win32";

let home: string;
let elsewhere: string;
/** The rule exactly as shipped: only `home` is injected, and no extra allowed roots. */
const check = (dir: string) => sensitiveDestination(dir, { home, allowRoots: [] });

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-home-")));
  elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-else-")));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(elsewhere, { recursive: true, force: true });
});

describe("sensitiveDestination: inside the home folder", () => {
  it("allows a folder inside home, existing or not", async () => {
    await fs.mkdir(path.join(home, "Documents", "Brightspace"), { recursive: true });
    expect(await check(path.join(home, "Documents"))).toBeNull();
    expect(await check(path.join(home, "Documents", "Brightspace"))).toBeNull();
    expect(await check(path.join(home, "Documents", "Brightspace", "ECE", "new"))).toBeNull();
    expect(await check(path.join(home, "Downloads"))).toBeNull();
  });

  it("refuses the home directory itself", async () => {
    expect(await check(home)).toMatch(/home directory/);
  });

  it.each([".ssh", ".kube", ".local/bin", ".oh-my-zsh/custom", ".gnupg", ".aws", ".config", ".zsh_plugins"])("refuses ~/%s", async (name) => {
    await fs.mkdir(path.join(home, name), { recursive: true });
    expect(await check(path.join(home, name))).toMatch(/hidden/);
  });

  it("refuses a hidden folder anywhere below home, not only at the top", async () => {
    await fs.mkdir(path.join(home, "Documents", ".hidden", "deeper"), { recursive: true });
    expect(await check(path.join(home, "Documents", ".hidden", "deeper"))).toMatch(/hidden/);
    expect(await check(path.join(home, "Documents", ".not", "yet", "there"))).toMatch(/hidden/);
  });

  it("allows a name that merely contains a dot", async () => {
    expect(await check(path.join(home, "ECE.264", "v1.2"))).toBeNull();
  });

  it.runIf(process.platform === "darwin")("refuses ~/Library at any depth, in any case", async () => {
    expect(await check(path.join(home, "Library", "LaunchAgents"))).toMatch(/Library/);
    expect(await check(path.join(home, "library"))).toMatch(/Library/);
  });

  it.runIf(process.platform === "linux")("allows a folder called Library on Linux", async () => {
    expect(await check(path.join(home, "Library"))).toBeNull();
  });

  it.runIf(process.platform === "win32")("refuses AppData", async () => {
    expect(await check(path.join(home, "AppData", "Roaming", "x"))).toMatch(/AppData/);
  });

  it.runIf(posix)("follows a symlink inside home to a hidden folder, and to a folder outside home", async () => {
    await fs.mkdir(path.join(home, ".ssh"));
    await fs.symlink(path.join(home, ".ssh"), path.join(home, "innocent"));
    await fs.symlink(elsewhere, path.join(home, "away"));
    expect(await check(path.join(home, "innocent"))).toMatch(/hidden/);
    expect(await check(path.join(home, "away"))).toMatch(/not inside your home/);
  });

  it("does not treat a sibling that merely shares the home prefix as inside home", async () => {
    const sibling = `${home}-other`;
    await fs.mkdir(sibling);
    try {
      expect(await check(sibling)).toMatch(/not inside your home/);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});

describe("sensitiveDestination: everything else is refused", () => {
  it("refuses an ordinary folder outside home", async () => {
    expect(await check(elsewhere)).toMatch(/not inside your home/);
  });

  it("refuses the root of a drive", async () => {
    expect(await check(path.parse(process.cwd()).root)).toMatch(/root/);
  });

  it.runIf(posix)("refuses system and shared folders that a denylist missed", async () => {
    for (const dir of ["/etc", "/usr/local", "/opt", "/var", "/Users", "/home", "/Applications", "/Library/LaunchAgents", "/bin", "/System", "/private/etc"]) {
      expect(await check(dir), dir).not.toBeNull();
    }
  });

  it.runIf(process.platform === "darwin")("refuses another user's home and the system volume link", async () => {
    expect(await check("/Users/Shared")).not.toBeNull();
    expect(await check("/Volumes/Macintosh HD/Users")).not.toBeNull();
    expect(await check("/Volumes/Macintosh HD")).not.toBeNull();
  });

  it.runIf(process.platform === "win32")("refuses \\\\?\\ and \\\\.\\ device paths outright", async () => {
    expect(await check("\\\\?\\C:\\Users\\x\\Documents")).toMatch(/device/);
    expect(await check("\\\\.\\C:\\x")).toMatch(/device/);
    expect(await check("//?/C:/x")).toMatch(/device/);
  });
});

describe("sensitiveDestination: external drives", () => {
  it.runIf(process.platform === "darwin")("allows a folder on an external volume, not hidden ones", async () => {
    expect(await check("/Volumes/USB/Courses/ECE")).toBeNull();
    expect(await check("/Volumes/USB")).toBeNull();
    expect(await check("/Volumes/USB/.Trashes/x")).not.toBeNull();
  });

  it.runIf(process.platform === "linux")("allows a folder under /media and /mnt, not their roots or hidden folders", async () => {
    expect(await check("/media/rohan/USB/Courses")).toBeNull();
    expect(await check("/mnt/usb/Courses")).toBeNull();
    expect(await check("/media")).not.toBeNull();
    expect(await check("/mnt")).not.toBeNull();
    expect(await check("/mnt/usb/.ssh")).not.toBeNull();
  });

  it.runIf(process.platform === "win32")("allows another drive's folder, never its system folders", async () => {
    const system = (process.env.SystemDrive ?? "C:").toUpperCase();
    const other = system === "D:" ? "E:" : "D:";
    expect(await check(`${other}\\Courses`)).toBeNull();
    for (const bad of ["Windows", "Program Files", "Program Files (x86)", "ProgramData"]) {
      expect(await check(`${other}\\${bad}\\x`), bad).not.toBeNull();
    }
    expect(await check(`${system}\\Courses`)).not.toBeNull();
  });
});

describe("sensitiveDestination: allowed roots for tests", () => {
  it("allows a folder under an injected root, but not a hidden folder in it", async () => {
    expect(await sensitiveDestination(path.join(elsewhere, "ok"), { home, allowRoots: [elsewhere] })).toBeNull();
    expect(await sensitiveDestination(path.join(elsewhere, ".hid"), { home, allowRoots: [elsewhere] })).toMatch(/not inside your home/);
  });
});

describe("sensitiveDestinationMessage", () => {
  it("tells the user a folder to choose instead", () => {
    expect(sensitiveDestinationMessage("/etc", "x")).toContain("~/Documents/Brightspace");
  });
});

describe("D2L_DOWNLOAD_ROOTS", () => {
  const saved = process.env.D2L_DOWNLOAD_ROOTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.D2L_DOWNLOAD_ROOTS;
    else process.env.D2L_DOWNLOAD_ROOTS = saved;
    vi.restoreAllMocks();
  });
  const withRoots = (...roots: string[]) => {
    process.env.D2L_DOWNLOAD_ROOTS = roots.join(path.delimiter);
  };

  it("allows a destination inside a listed root, and the root itself", async () => {
    withRoots(elsewhere);
    expect(await check(elsewhere)).toBeNull();
    expect(await check(path.join(elsewhere, "courses", "ECE"))).toBeNull();
  });

  it("still refuses what is outside the listed roots, and a hidden folder inside one", async () => {
    withRoots(elsewhere);
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-other-")));
    try {
      expect(await check(other)).toMatch(/not inside your home/);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
    expect(await check(path.join(elsewhere, ".hidden"))).toMatch(/not inside your home/);
  });

  it("is not in force when the variable is unset or empty", async () => {
    delete process.env.D2L_DOWNLOAD_ROOTS;
    expect(await check(elsewhere)).toMatch(/not inside your home/);
    process.env.D2L_DOWNLOAD_ROOTS = "";
    expect(await check(elsewhere)).toMatch(/not inside your home/);
  });

  it("follows a symlinked root to its real path", async () => {
    if (!posix) return;
    const link = path.join(home, "linked-root");
    await fs.symlink(elsewhere, link);
    withRoots(link);
    expect(await check(path.join(elsewhere, "x"))).toBeNull();
  });

  it("parses a path-delimiter list, ignoring blanks and spaces around entries", async () => {
    const second = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-second-")));
    try {
      expect(await downloadRootsFromEnv(` ${elsewhere} ${path.delimiter}${path.delimiter}${second}${path.delimiter}`, home)).toEqual([elsewhere, second]);
      expect(await downloadRootsFromEnv(undefined, home)).toEqual([]);
      expect(await downloadRootsFromEnv("", home)).toEqual([]);
    } finally {
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  it.each([
    ["a relative path", () => "data/courses"],
    ["the filesystem root", () => path.parse(process.cwd()).root],
    ["the home directory itself", () => home],
    ["a folder that holds the home directory", () => path.dirname(home)],
    ["a hidden folder", () => path.join(elsewhere, ".secret")],
    ["a folder inside a hidden folder", () => path.join(elsewhere, ".a", "b")],
    ["a device path", () => "//?/data"],
  ])("ignores %s with a warning, and does not allow a destination inside it", async (_label, entry) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const value = entry();
    withRoots(value);
    expect(await downloadRootsFromEnv(value, home)).toEqual([]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("D2L_DOWNLOAD_ROOTS"))).toBe(true);
    expect(await check(path.join(elsewhere, "inside"))).toMatch(/not inside your home/);
  });

  it.runIf(posix)("ignores system folders", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const dir of ["/etc", "/usr/local", "/System", "/Library", "/Applications", "/root"]) {
      expect(await downloadRootsFromEnv(dir, home), dir).toEqual([]);
    }
  });

  it("keeps the valid entries when others are ignored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await downloadRootsFromEnv(["relative", elsewhere, "/"].join(path.delimiter), home)).toEqual([elsewhere]);
  });

  it("names the variable in the refusal text", () => {
    expect(sensitiveDestinationMessage("/data", "x")).toContain("D2L_DOWNLOAD_ROOTS");
  });
});

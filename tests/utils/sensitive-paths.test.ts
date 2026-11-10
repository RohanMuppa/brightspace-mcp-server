import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadRootsFromEnv, resetDownloadRootWarnings, sensitiveDestination, sensitiveDestinationMessage } from "../../src/utils/sensitive-paths.js";

const posix = process.platform !== "win32";
const darwin = process.platform === "darwin";

let home: string;
let work: string;
const savedRoots = process.env.D2L_DOWNLOAD_ROOTS;
/** The rule as shipped: only `home` is injected, so no machine-specific folder matters. */
const check = (dir: string) => sensitiveDestination(dir, { home, allowRoots: [] });

beforeEach(async () => {
  delete process.env.D2L_DOWNLOAD_ROOTS;
  resetDownloadRootWarnings();
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-home-")));
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-work-")));
});
afterEach(async () => {
  if (savedRoots === undefined) delete process.env.D2L_DOWNLOAD_ROOTS;
  else process.env.D2L_DOWNLOAD_ROOTS = savedRoots;
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

describe("what is allowed", () => {
  it("allows folders in home, existing or not, and temp folders", async () => {
    expect(await check(path.join(home, "Documents", "Brightspace", "ECE", "new"))).toBeNull();
    expect(await check(path.join(home, "Downloads"))).toBeNull();
    expect(await check(work)).toBeNull();
    expect(await check(path.join(work, "anything", "deep"))).toBeNull();
    expect(await check(os.tmpdir())).toBeNull();
  });

  it("allows a name that merely contains a dot", async () => {
    expect(await check(path.join(home, "ECE.264", "v1.2"))).toBeNull();
  });

  it.runIf(posix)("allows the places a server or container saves to", async () => {
    for (const dir of ["/tmp", "/tmp/courses", "/srv/courses", "/data", "/data/courses", "/workspace", "/workspaces/proj", "/opt/courses", "/mnt/usb/Courses", "/media/rohan/USB", "/run/media/rohan/USB", "/Volumes/USB/Courses", "/var/tmp/x", "/var/folders/ab/cdef/T/x", "/private/tmp/x", "/private/var/folders/ab/cdef/T/x"]) {
      expect(await check(dir), dir).toBeNull();
    }
  });

  it.runIf(darwin)("allows cloud-sync folders under ~/Library", async () => {
    expect(await check(path.join(home, "Library", "CloudStorage", "Dropbox", "Courses"))).toBeNull();
    expect(await check(path.join(home, "Library", "CloudStorage", "GoogleDrive-me@x.edu", "My Drive"))).toBeNull();
    expect(await check(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Courses"))).toBeNull();
    expect(await check(path.join(home, "library", "cloudstorage", "OneDrive", "x"))).toBeNull();
  });
});

describe("what is refused", () => {
  it("refuses the home directory itself and a drive root", async () => {
    expect(await check(home)).toMatch(/home directory/);
    expect(await check(path.parse(process.cwd()).root)).toMatch(/root/);
  });

  it.each([".ssh", ".kube", ".local/bin", ".oh-my-zsh/custom", ".config", ".gnupg", ".aws"])("refuses ~/%s whether or not it exists", async (name) => {
    expect(await check(path.join(home, name))).toMatch(/hidden folder/);
  });

  it("refuses a hidden folder anywhere in the path, even outside home", async () => {
    expect(await check(path.join(work, "project", ".git", "hooks"))).toMatch(/\.git/);
    expect(await check(path.join(home, "Documents", ".hidden", "deeper"))).toMatch(/hidden/);
    expect(await check(path.join(work, ".cache"))).toMatch(/hidden/);
  });

  it.runIf(darwin)("refuses the rest of ~/Library", async () => {
    for (const sub of ["LaunchAgents", "Preferences", "Application Support", "Mobile", "CloudStorageX", "."]) {
      expect(await check(path.join(home, "Library", sub === "." ? "" : sub, "x")), sub).toMatch(/Library/);
    }
    expect(await check(path.join(home, "Library"))).toMatch(/Library/);
    expect(await check(path.join(home, "library", "LaunchAgents"))).toMatch(/Library/);
  });

  it.runIf(process.platform === "linux")("allows a folder called Library on Linux", async () => {
    expect(await check(path.join(home, "Library"))).toBeNull();
  });

  it.runIf(posix)("refuses system folders", async () => {
    for (const dir of ["/etc", "/etc/cron.d", "/usr", "/usr/local/bin", "/bin", "/sbin", "/System", "/System/Library", "/Library/LaunchAgents", "/Applications", "/boot", "/dev", "/proc", "/sys", "/lib", "/lib64/x", "/private/etc", "/var", "/var/lib/x", "/var/root", "/private/var", "/private/var/db", "/root"]) {
      expect(await check(dir), dir).not.toBeNull();
    }
  });

  it.runIf(posix)("names the rule that refused it", async () => {
    expect(await check("/etc")).toMatch(/\/etc, a system folder/);
    expect(await check("/var/lib")).toMatch(/\/var/);
  });

  it.runIf(process.platform === "linux")("refuses /root unless it is the home folder's parent", async () => {
    expect(await check("/root/courses")).toMatch(/administrator/);
    expect(await sensitiveDestination("/root/courses", { home: "/root", allowRoots: [] })).toBeNull();
  });

  it.runIf(posix)("judges an AppData folder below a Temp folder on its own, so a fake home in Temp cannot open the Startup folder", async () => {
    expect(await check("/mnt/c/Users/me/AppData/Local/Temp/x")).toBeNull();
    expect(await check("/mnt/c/Users/me/AppData/Local/Temp/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup")).toMatch(/AppData/);
    expect(await check("/mnt/d/AppData/Roaming/x")).toMatch(/AppData/);
  });

  it.runIf(process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 0)(
    "refuses a folder inside one this user may not read, with the rule rather than a raw error",
    async () => {
      expect(await check("/root/courses")).toMatch(/administrator/);
      expect(await check("/root")).toMatch(/administrator/);
    },
  );

  it.runIf(posix)("refuses Windows folders seen from WSL", async () => {
    for (const dir of ["/mnt/c/Windows/System32", "/mnt/c/Program Files/x", "/mnt/d/Program Files (x86)", "/mnt/c/ProgramData", "/mnt/c/Users/me/AppData/Roaming/x", "/mnt/c/Users/me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"]) {
      expect(await check(dir), dir).not.toBeNull();
    }
    expect(await check("/mnt/c/Users/me/Documents/Courses")).toBeNull();
    expect(await check("/mnt/d/Courses")).toBeNull();
  });

  it.runIf(process.platform === "win32")("refuses Windows system and AppData folders on any drive, and device paths", async () => {
    for (const dir of ["C:\\Windows\\x", "D:\\Windows", "D:\\Program Files\\x", "E:\\Program Files (x86)\\x", "D:\\ProgramData", path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")]) {
      expect(await check(dir), dir).not.toBeNull();
    }
    expect(await check("\\\\?\\C:\\Users\\x\\Documents")).toMatch(/device/);
    expect(await check("\\\\.\\C:\\x")).toMatch(/device/);
    expect(await check("//?/C:/x")).toMatch(/device/);
    expect(await check(path.join(home, "Documents"))).toBeNull();
    expect(await check("D:\\Courses")).toBeNull();
  });

  it.runIf(posix)("follows a symlink to where it really points", async () => {
    await fs.mkdir(path.join(home, ".ssh"));
    await fs.symlink(path.join(home, ".ssh"), path.join(work, "innocent"));
    await fs.symlink("/etc", path.join(work, "etc-link"));
    expect(await check(path.join(work, "innocent"))).toMatch(/hidden/);
    expect(await check(path.join(work, "innocent", "sub"))).toMatch(/hidden/);
    expect(await check(path.join(work, "etc-link"))).toMatch(/system folder/);
  });

  it.runIf(posix)("judges a dangling symlink by its target, not its own name", async () => {
    await fs.symlink(path.join(home, ".ssh", "not-yet"), path.join(work, "dangling-hidden"));
    await fs.symlink("/etc/not-there-yet", path.join(work, "dangling-etc"));
    await fs.symlink(path.join(work, "future"), path.join(work, "dangling-fine"));
    expect(await check(path.join(work, "dangling-hidden"))).toMatch(/hidden/);
    expect(await check(path.join(work, "dangling-hidden", "deeper"))).toMatch(/hidden/);
    expect(await check(path.join(work, "dangling-etc"))).toMatch(/\/etc/);
    expect(await check(path.join(work, "dangling-fine"))).toBeNull();
  });

  it.runIf(posix)("refuses a symlink loop with a clear reason, not a raw error", async () => {
    await fs.symlink(path.join(work, "b"), path.join(work, "a"));
    await fs.symlink(path.join(work, "a"), path.join(work, "b"));
    expect(await check(path.join(work, "a"))).toMatch(/symbolic-link loop/);
    expect(await check(path.join(work, "a", "x"))).toMatch(/symbolic-link loop/);
  });

  it("does not treat a sibling that merely shares the home prefix as the home folder", async () => {
    const sibling = `${home}-other`;
    await fs.mkdir(sibling);
    try {
      expect(await check(sibling)).toBeNull();
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});

describe("D2L_DOWNLOAD_ROOTS", () => {
  const withRoots = (...roots: string[]) => {
    process.env.D2L_DOWNLOAD_ROOTS = roots.join(path.delimiter);
  };

  it("lets a listed root override the soft rules, inside home too", async () => {
    const hiddenRoot = path.join(home, ".courses");
    await fs.mkdir(hiddenRoot);
    expect(await check(path.join(hiddenRoot, "ECE"))).toMatch(/hidden/);
    withRoots(hiddenRoot);
    expect(await check(hiddenRoot)).toBeNull();
    expect(await check(path.join(hiddenRoot, "ECE", "deeper"))).toBeNull();
    // Only what is inside the root.
    expect(await check(path.join(home, ".ssh"))).toMatch(/hidden/);
  });

  it.runIf(darwin)("can unblock a ~/Library folder", async () => {
    withRoots(path.join(home, "Library", "Courses"));
    expect(await check(path.join(home, "Library", "Courses", "ECE"))).toBeNull();
    expect(await check(path.join(home, "Library", "LaunchAgents"))).toMatch(/Library/);
  });

  it.runIf(posix)("can unblock a system folder the operator really means", async () => {
    withRoots("/usr/local/courses");
    expect(await check("/usr/local/courses/ECE")).toBeNull();
    expect(await check("/usr/local/bin")).not.toBeNull();
  });

  it("never allows the home folder itself or a drive root, whatever is listed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withRoots(home, path.parse(process.cwd()).root);
    expect(await check(home)).toMatch(/home directory/);
    expect(await check(path.parse(process.cwd()).root)).toMatch(/root/);
    expect(await check(path.join(home, ".ssh"))).toMatch(/hidden/);
  });

  it("never allows a device path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withRoots("//?/data");
    expect(await check("//?/data/x")).toMatch(/device/);
  });

  it("is not in force when the variable is unset or empty", async () => {
    expect(await check(path.join(work, ".hid"))).toMatch(/hidden/);
    process.env.D2L_DOWNLOAD_ROOTS = "";
    expect(await check(path.join(work, ".hid"))).toMatch(/hidden/);
  });

  it("parses a path-delimiter list, ignoring blanks and spaces around entries", async () => {
    const second = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-second-")));
    try {
      expect(await downloadRootsFromEnv(` ${work} ${path.delimiter}${path.delimiter}${second}${path.delimiter}`, home)).toEqual([work, second]);
      expect(await downloadRootsFromEnv(undefined, home)).toEqual([]);
      expect(await downloadRootsFromEnv("", home)).toEqual([]);
    } finally {
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  it("follows a symlinked root to its real path", async () => {
    if (!posix) return;
    await fs.mkdir(path.join(work, ".real"));
    await fs.symlink(path.join(work, ".real"), path.join(work, "link"));
    withRoots(path.join(work, "link"));
    expect(await check(path.join(work, ".real", "x"))).toBeNull();
  });

  it.each([
    ["a relative path", () => "data/courses"],
    ["the filesystem root", () => path.parse(process.cwd()).root],
    ["the home directory itself", () => home],
    ["a folder that holds the home directory", () => path.dirname(home)],
    ["a device path", () => "//?/data"],
  ])("ignores %s with a warning", async (_label, entry) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await downloadRootsFromEnv(entry(), home)).toEqual([]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("D2L_DOWNLOAD_ROOTS"))).toBe(true);
  });

  it("keeps the valid entries when others are ignored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await downloadRootsFromEnv(["relative", work, "/"].join(path.delimiter), home)).toEqual([work]);
  });

  it("no longer drops temp, var, opt or private folders: they are allowed anyway", async () => {
    expect(await downloadRootsFromEnv(work, home)).toEqual([work]);
    expect(await check(path.join(work, "x"))).toBeNull();
  });
});

describe("sensitiveDestinationMessage", () => {
  it("names the rule, a folder to choose and D2L_DOWNLOAD_ROOTS", () => {
    const text = sensitiveDestinationMessage("/etc", "it is inside /etc, a system folder");
    expect(text).toContain("it is inside /etc, a system folder");
    expect(text).toContain("~/Documents/Brightspace");
    expect(text).toContain("D2L_DOWNLOAD_ROOTS");
  });
});

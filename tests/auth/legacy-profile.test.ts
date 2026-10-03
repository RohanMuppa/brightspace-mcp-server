import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import trash from "trash";
import { retireLegacyProfile } from "../../src/auth/legacy-profile.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), access: vi.fn(), readlink: vi.fn() }));
vi.mock("trash", () => ({ default: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));

const sessionDir = path.join(os.tmpdir(), "dummy-legacy-profile-test");
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

describe("retiring the legacy browser profile", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false } as never);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readlink).mockRejectedValue(missing());
    vi.mocked(trash).mockResolvedValue(undefined);
  });

  it("uses recoverable Trash only after encrypted state exists", async () => {
    await retireLegacyProfile(sessionDir);
    expect(fs.access).toHaveBeenCalledWith(path.join(sessionDir, "storage-state.encrypted.json"));
    expect(trash).toHaveBeenCalledWith([path.join(sessionDir, "browser-data")], { glob: false });
    expect(vi.mocked(fs.access).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(trash).mock.invocationCallOrder[0]);
  });

  it("preserves the profile when encrypted state was not saved", async () => {
    vi.mocked(fs.access).mockRejectedValue(missing());
    await retireLegacyProfile(sessionDir);
    expect(trash).not.toHaveBeenCalled();
  });

  it("never follows a profile symlink", async () => {
    vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => true } as never);
    await retireLegacyProfile(sessionDir);
    expect(trash).not.toHaveBeenCalled();
  });

  it("preserves a profile owned by a live local process", async () => {
    vi.mocked(fs.readlink).mockResolvedValue(`${os.hostname()}-12345`);
    const probe = vi.spyOn(process, "kill").mockReturnValue(true);
    await retireLegacyProfile(sessionDir);
    expect(probe).toHaveBeenCalledWith(12345, 0);
    expect(trash).not.toHaveBeenCalled();
  });

  it.each(["another-host-12345", "unknown-lock-format"])("preserves uncertain lock ownership: %s", async owner => {
    vi.mocked(fs.readlink).mockResolvedValue(owner);
    await retireLegacyProfile(sessionDir);
    expect(trash).not.toHaveBeenCalled();
  });

  it("treats permission-denied PID probes as possibly alive", async () => {
    vi.mocked(fs.readlink).mockResolvedValue(`${os.hostname()}-12345`);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await retireLegacyProfile(sessionDir);
    expect(trash).not.toHaveBeenCalled();
  });

  it("retires the profile when its recorded local owner is confirmed gone", async () => {
    vi.mocked(fs.readlink).mockResolvedValue(`${os.hostname()}-12345`);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await retireLegacyProfile(sessionDir);
    expect(trash).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import { runRepair } from "../src/repair.js";
import type { ChromiumStatus } from "../src/utils/browser-install.js";

describe("repair (without school, credentials, client registration or sign-in)", () => {
  const ready: ChromiumStatus = { headless: "present", visible: true };
  it("is idempotent and verifies a ready browser without downloading", async () => {
    const install = vi.fn();
    expect((await runRepair({ status: async () => ready, install })).ok).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });
  it("installs a missing browser then verifies it, even with successful installer exit", async () => {
    const status = vi.fn().mockResolvedValueOnce({ headless: "missing", visible: false }).mockResolvedValue(ready);
    const install = vi.fn(async () => ({ ok: true }));
    expect((await runRepair({ status, install })).ok).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(2);
    status.mockResolvedValue({ headless: "missing", visible: false });
    expect((await runRepair({ status, install })).ok).toBe(false);
  });
  it("does not call a blocked launch healthy or attempt to fix it with downloads", async () => {
    const install = vi.fn();
    expect((await runRepair({ status: async () => ({ headless: "unknown", visible: true }), install })).ok).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });
  it("reports missing dependency code without invoking a missing installer", async () => {
    const install = vi.fn();
    const result = await runRepair({ status: async () => ({ headless: "dependency_missing", visible: false }), install });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("npm ci --prefix");
    expect(install).not.toHaveBeenCalled();
  });
});

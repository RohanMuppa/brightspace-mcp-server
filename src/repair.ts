import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromiumStatus, chromiumReady, installChromium, dependencyRepairHint, BROWSER_REPAIR_COMMAND } from "./utils/browser-install.js";

/** Browser maintenance only: no config, credential-store, client or sign-in imports. */
export async function runRepair(deps = { status: chromiumStatus, install: installChromium }): Promise<{ ok: boolean; message: string }> {
  let status = await deps.status();
  if (status.headless === "dependency_missing") return { ok: false, message: dependencyRepairHint() };
  if (status.headless === "missing" || !status.visible) {
    const installed = await deps.install();
    if (!installed.ok) return { ok: false, message: `Chromium installation failed. Check your connection and retry: ${BROWSER_REPAIR_COMMAND}` };
    status = await deps.status();
  }
  return chromiumReady(status)
    ? { ok: true, message: "Chromium is installed and a headless launch and close succeeded." }
    : { ok: false, message: "Chromium could not launch. Check operating system permissions and browser system dependencies, then run repair again." };
}

export async function main(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.some(arg => arg !== "--json")) {
    console.error("Usage: brightspace-mcp-server repair [--json]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runRepair();
    console.log(args.includes("--json") ? JSON.stringify(result) : result.message);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error(`Browser repair failed. Run: ${BROWSER_REPAIR_COMMAND}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

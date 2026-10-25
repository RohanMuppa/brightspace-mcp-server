// Real published-package recovery with isolated browser/config directories.
// Run via npm so its own npm-cli path is available on Windows without a shell.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "brightspace-install-smoke-"));
const env = { ...process.env, HOME: root, USERPROFILE: root, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"), D2L_NO_UPDATE_CHECK: "true" };
function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 600_000, ...options });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
/**
 * Windows keeps a folder locked for a moment after a browser that ran from it
 * exits, and a rename then fails with EPERM or EBUSY. Retry briefly, as
 * rmSync's maxRetries does, rather than fail the run on that lag.
 */
async function renameWhenFree(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= 40) throw error;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
}
function npm(args) {
  assert.ok(process.env.npm_execpath, "Run this smoke test with npm run test:install");
  return run([process.env.npm_execpath, ...args]);
}
try {
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root]));
  const metadata = Array.isArray(packed) ? packed[0] : packed["brightspace-mcp-server"];
  console.log("Installing the packed package in an isolated directory...");
  npm(["install", "--prefix", root, "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund", join(root, metadata.filename)]);
  const pkg = join(root, "node_modules", "brightspace-mcp-server");
  const entry = join(pkg, "build", "index.js");
  // Explicitly exercise the shipped postinstall even when npm policy disables it.
  console.log("Verifying the packaged postinstall and headless browser...");
  run([join(pkg, "scripts", "install-browser.cjs")]);
  assert.equal(JSON.parse(run([entry, "repair", "--json"])).ok, true);
  await mkdir(join(root, ".codex"));
  const config = join(root, ".codex", "config.toml");
  await writeFile(config, "# client config must remain untouched\n");

  await renameWhenFree(env.PLAYWRIGHT_BROWSERS_PATH, join(root, "pruned-browser-cache"));
  console.log("Verifying automatic recovery after browser-cache removal...");
  const moduleUrl = pathToFileURL(join(pkg, "build", "utils", "browser-install.js")).href;
  const playwright = createRequire(join(pkg, "package.json")).resolve("playwright");
  // A separate process ensures Playwright reads the isolated browser path.
  run(["--input-type=module", "-e", `
    const { launchWithBrowserRecovery } = await import(${JSON.stringify(moduleUrl)});
    const { chromium } = (await import(${JSON.stringify(pathToFileURL(playwright).href)})).default;
    const browser = await launchWithBrowserRecovery(() => chromium.launch({ headless: true }));
    await browser.close();
  `]);
  assert.equal(JSON.parse(run([entry, "repair", "--json"])).ok, true);
  assert.equal(await readFile(config, "utf8"), "# client config must remain untouched\n");

  const dependency = dirname(createRequire(join(pkg, "package.json")).resolve("playwright/package.json"));
  await renameWhenFree(dependency, join(root, "pruned-playwright-code"));
  const damaged = spawnSync(process.execPath, [entry, "repair", "--json"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(damaged.status, 1);
  assert.match(JSON.parse(damaged.stdout).message, /npm install --prefix/);
  console.log("PASS: packaged postinstall, cache recovery, idempotent repair, missing dependency diagnosis, unchanged client configuration.");
} finally {
  // Only the unique test directory created above can be removed.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

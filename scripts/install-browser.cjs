// Works in both a source checkout (before build) and the published tarball.
// Resolve this package's dependency, never a Playwright from the caller's cwd.
const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");
const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  console.error("Chromium installation failed. Retry with brightspace-mcp-server repair after installation completes.");
  process.exit(1);
}
require("playwright").chromium.launch({ headless: true, timeout: 30_000 })
  .then(browser => browser.close())
  .catch(() => {
    console.error("Chromium was downloaded but could not launch. Check operating system permissions and browser system dependencies.");
    process.exitCode = 1;
  });

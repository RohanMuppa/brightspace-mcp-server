import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

// Any test that saves a topic or syncs a course writes the saved-topic ledger
// under the home directory's ~/.brightspace-mcp. Point the home at a temporary
// folder so no test touches the real one. This imports nothing from src/, so a
// test's own vi.mock of a src module still applies to the first import.
const home = fsSync.mkdtempSync(path.join(os.tmpdir(), "test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

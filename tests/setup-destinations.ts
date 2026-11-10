import fs from "node:fs";
import os from "node:os";
import { configureDestinationPolicy } from "../src/utils/sensitive-paths.js";

// Tests write into temporary folders, which are outside the home folder the rule allows.
// The temp root is added as an allowed root; the rule itself is unchanged and has its own tests.
configureDestinationPolicy({ allowRoots: [fs.realpathSync.native(os.tmpdir())] });

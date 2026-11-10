import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "publish.yml"), "utf8").replace(/\r\n/g, "\n");

describe("publish workflow", () => {
  it("runs one publish at a time and never cancels one in progress", () => {
    // Two merges once published concurrently and the older version finished last,
    // leaving npm's `latest` on it.
    expect(workflow).toMatch(/^concurrency:\n  group: publish-npm\n  cancel-in-progress: false$/m);
  });

  it("publishes only a version greater than the one on npm", () => {
    const step = workflow.slice(workflow.indexOf("- name: Publish if version changed"), workflow.indexOf("# Tags the commit"));
    expect(step).toContain("npm view brightspace-mcp-server version");
    expect(step).toContain("IS_NEWER");
    expect(step).not.toMatch(/\[ "\$CURRENT" != "\$PUBLISHED" \]/);
  });

  it("compares versions numerically, not as text", () => {
    const script = /IS_NEWER=\$\(node -e '([\s\S]*?)' "\$CURRENT" "\$PUBLISHED"\)/.exec(workflow)?.[1];
    expect(script).toBeTruthy();
    const newer = (a: string, b: string) => execFileSync("node", ["-e", script!, a, b], { encoding: "utf8" }).trim();
    expect(newer("5.1.43", "5.1.42")).toBe("true");
    expect(newer("5.1.42", "5.1.43")).toBe("false");
    expect(newer("5.1.43", "5.1.43")).toBe("false");
    expect(newer("5.10.0", "5.9.9")).toBe("true");
    expect(newer("5.2.0", "5.1.43")).toBe("true");
    expect(newer("6.0.0", "5.99.99")).toBe("true");
    expect(newer("5.1.43", "0.0.0")).toBe("true");
  });
});

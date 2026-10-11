import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/auth/javeriana-sso.ts"), "utf8");

describe("javeriana-sso.ts attribution", () => {
  it("credits the fork's author by their current name", () => {
    expect(source).toContain("Ported from Joshua Montclair (@JoshuaMontclair)'s fork");
  });

  it("no longer carries the author's former surname", () => {
    expect(source).not.toContain("Mendez");
  });
});

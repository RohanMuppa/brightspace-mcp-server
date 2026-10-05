import { describe, it, expect } from "vitest";
import { stripD2lSessionParams } from "../../src/utils/session-params.js";

describe("stripD2lSessionParams", () => {
  it("removes session params case-insensitively from a relative URL, keeping routing params", () => {
    expect(
      stripD2lSessionParams(
        "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&D2LSESSIONVAL=a&type=lti&d2lsecuresessionval=b&rcode=x&_=123"
      )
    ).toBe("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=x");
  });

  it("handles absolute URLs and preserves the fragment", () => {
    expect(stripD2lSessionParams("https://d2l.example.edu/x?d2lSessionVal=a&ou=1#top")).toBe(
      "https://d2l.example.edu/x?ou=1#top"
    );
  });

  it("drops the '?' when only session params were present", () => {
    expect(stripD2lSessionParams("/x?d2lSessionVal=a&d2lSecureSessionVal=b")).toBe("/x");
  });

  it("leaves URLs without session params unchanged", () => {
    expect(stripD2lSessionParams("/x?ou=1&type=lti")).toBe("/x?ou=1&type=lti");
    expect(stripD2lSessionParams("/x#frag?d2lSessionVal=a")).toBe("/x#frag?d2lSessionVal=a");
  });
});

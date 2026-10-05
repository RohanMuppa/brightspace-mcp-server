import { describe, it, expect } from "vitest";
import { readLtiLaunchPage, toBrightspacePath } from "../../../src/utils/transcript/lti.js";

const ORIGIN = "https://purdue.brightspace.com";
const PATH = "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=FIXTURE";

describe("toBrightspacePath (#190)", () => {
  it("keeps a relative /d2l/ link", () => {
    expect(toBrightspacePath(PATH, ORIGIN)).toBe(PATH);
    expect(toBrightspacePath(PATH)).toBe(PATH);
  });

  it("normalizes an absolute same-origin /d2l/ URL to its path and query", () => {
    expect(toBrightspacePath(`${ORIGIN}${PATH}`, ORIGIN)).toBe(PATH);
    expect(toBrightspacePath(`HTTPS://PURDUE.brightspace.com:443${PATH}#frag`, ORIGIN)).toBe(PATH);
  });

  it.each([
    `https://purdue.brightspace.com.evil.example${PATH}`,
    `http://purdue.brightspace.com${PATH}`,
    `https://purdue.brightspace.com@evil.example${PATH}`,
    `https://user:pw@purdue.brightspace.com${PATH}`,
    `https://purdue.brightspace.com:8443${PATH}`,
    `//purdue.brightspace.com${PATH}`,
    `https://purdue.brightspace.com/content/video.mp4`,
    "javascript:alert(1)",
  ])("rejects %s", url => {
    expect(toBrightspacePath(url, ORIGIN)).toBeNull();
  });

  it("rejects absolute URLs when no origin is configured", () => {
    expect(toBrightspacePath(`${ORIGIN}${PATH}`)).toBeNull();
  });
});

describe("readLtiLaunchPage with an origin", () => {
  it("returns an absolute same-origin framed launch as a path", () => {
    const html = `<iframe src="${ORIGIN}/d2l/le/lti/101/toolLaunch/77"></iframe>`;
    expect(readLtiLaunchPage(html, ORIGIN)).toEqual({ nextPath: "/d2l/le/lti/101/toolLaunch/77" });
  });

  it("ignores a framed /d2l/ link on another origin", () => {
    const html = `<iframe src="https://evil.example/d2l/le/lti/101/toolLaunch/77"></iframe>`;
    expect(readLtiLaunchPage(html, ORIGIN)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { decodeEntities, tagAttributes } from "../../src/utils/html-attributes.js";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a&amp;b &quot;c&quot; &#39;d&#39; &#x1F600;")).toBe("a&b \"c\" 'd' \u{1F600}");
  });

  it("keeps a reference past U+10FFFF as written instead of throwing (#352)", () => {
    expect(decodeEntities("x&#x110000;y&#99999999;z")).toBe("x&#x110000;y&#99999999;z");
  });
});

describe("tagAttributes", () => {
  it("still reads a link whose other attribute holds an invalid reference (#352)", () => {
    const [anchor] = tagAttributes('<a title="&#99999999;" href="/d2l/a?b=1&amp;c=2">x</a>', "a");
    expect(anchor.get("href")).toBe("/d2l/a?b=1&c=2");
    expect(anchor.get("title")).toBe("&#99999999;");
  });
});

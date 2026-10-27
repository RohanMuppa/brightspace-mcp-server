import { describe, it, expect } from "vitest";
import { decodeEntities, tagAttributes } from "../../src/utils/html-attributes.js";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a&amp;b &quot;c&quot; &#39;d&#39; &#x1F600;")).toBe("a&b \"c\" 'd' \u{1F600}");
  });

  it("keeps a reference past U+10FFFF as written instead of throwing (#352)", () => {
    expect(decodeEntities("x&#x110000;y&#99999999;z")).toBe("x&#x110000;y&#99999999;z");
  });

  it("decodes each reference once, so an encoded ampersand stays literal (#360)", () => {
    expect(decodeEntities("&#38;lt;b&#38;gt; &#x26;amp; &#38;quot; &amp;lt;")).toBe("&lt;b&gt; &amp; &quot; &lt;");
  });
});

describe("tagAttributes", () => {
  it("still reads a link whose other attribute holds an invalid reference (#352)", () => {
    const [anchor] = tagAttributes('<a title="&#99999999;" href="/d2l/a?b=1&amp;c=2">x</a>', "a");
    expect(anchor.get("href")).toBe("/d2l/a?b=1&c=2");
    expect(anchor.get("title")).toBe("&#99999999;");
  });

  it("keeps an encoded ampersand in an href literal (#360)", () => {
    const [anchor] = tagAttributes('<a href="/d2l/a?q=&#38;quot;x&amp;y=1">x</a>', "a");
    expect(anchor.get("href")).toBe("/d2l/a?q=&quot;x&y=1");
  });

  it("reads past a '>' inside a quoted value instead of ending the tag there (#376)", () => {
    const [anchor] = tagAttributes(
      `<a title="Week 1 > Notes" data-x='a>b' href="/d2l/a?b=1">x</a>`,
      "a"
    );
    expect(anchor.get("title")).toBe("Week 1 > Notes");
    expect(anchor.get("data-x")).toBe("a>b");
    expect(anchor.get("href")).toBe("/d2l/a?b=1");
  });

  it("still ends a tag with an unbalanced quote at its first '>' (#376)", () => {
    const anchors = tagAttributes('<a href="/d2l/a title=x>one</a> <a href="/d2l/b">two</a>', "a");
    expect(anchors).toHaveLength(2);
    expect(anchors[1].get("href")).toBe("/d2l/b");
  });
});

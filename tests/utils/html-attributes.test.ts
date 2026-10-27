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

  it("reads every attribute when an earlier quoted value contains > (#376)", () => {
    const html =
      '<a title="Week 1 > Notes" href="/d2l/common/viewFile.d2lfile/1">x</a>' +
      "<img alt='a > b' src=\"/pic.png\">";
    const [anchor] = tagAttributes(html, "a");
    expect(anchor.get("title")).toBe("Week 1 > Notes");
    expect(anchor.get("href")).toBe("/d2l/common/viewFile.d2lfile/1");
    const [image] = tagAttributes(html, "img");
    expect(image.get("alt")).toBe("a > b");
    expect(image.get("src")).toBe("/pic.png");
  });

  it("still ends a tag with an unbalanced quote at its first > (#376)", () => {
    const [anchor] = tagAttributes('<a href="/d2l/x title=y>broken', "a");
    expect([...anchor]).toEqual([]);
    const [link] = tagAttributes('<a id="1" href="/d2l/x>broken', "a");
    expect([...link]).toEqual([["id", "1"]]);
  });

  it("does not let an apostrophe in an unquoted value swallow the next tag (#376)", () => {
    const anchors = tagAttributes(`<a title=Bob's href="/x">Bob's <a href="/y">`, "a");
    expect(anchors.map(anchor => anchor.get("href"))).toEqual(["/x", "/y"]);
  });
});

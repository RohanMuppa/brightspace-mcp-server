import { describe, it, expect } from "vitest";
import { convertHtmlToMarkdown } from "../../src/utils/html-converter.js";

/**
 * D2L descriptions are authored in a rich-text editor, so they arrive as real
 * page HTML: grading tables, pasted stylesheets, the lot. Whatever this
 * function drops is dropped for good -- the markdown is what the model reads.
 */

describe("convertHtmlToMarkdown", () => {
  it("returns empty output for empty input", () => {
    expect(convertHtmlToMarkdown("")).toEqual({ markdown: "", html: "" });
    expect(convertHtmlToMarkdown("   \n ")).toEqual({ markdown: "", html: "" });
  });

  it("keeps ordinary prose, lists and code intact", () => {
    const { markdown } = convertHtmlToMarkdown(
      "<h2>Lab 3</h2><p>Read <a href='https://x.test/s'>the spec</a>.</p><ul><li>one</li><li>two</li></ul><pre><code>int x = 1;</code></pre>"
    );
    expect(markdown).toContain("## Lab 3");
    expect(markdown).toContain("[the spec](https://x.test/s)");
    expect(markdown).toContain("one");
    expect(markdown).toContain("int x = 1;");
  });

  describe("tables", () => {
    /**
     * A grading table used to come out as "Homework\n\n30%\n\nExams\n\n70%":
     * every cell its own paragraph, no column boundaries, and nothing left to
     * say which weight belonged to which item. With more than two columns the
     * pairing is unrecoverable, and this is the single most-asked-about table
     * in any syllabus.
     */
    const GRADING = `<p>Grading</p><table><thead><tr><th>Item</th><th>Weight</th><th>Due</th></tr></thead>
      <tbody><tr><td>Homework</td><td>30%</td><td>Weekly</td></tr>
      <tr><td>Midterm</td><td>25%</td><td>Oct 14</td></tr>
      <tr><td>Final</td><td>45%</td><td>Dec 12</td></tr></tbody></table>`;

    it("renders a GFM table that keeps each row's cells together", () => {
      const { markdown } = convertHtmlToMarkdown(GRADING);
      expect(markdown).toContain("| Item | Weight | Due |");
      expect(markdown).toContain("| --- | --- | --- |");
      expect(markdown).toContain("| Homework | 30% | Weekly |");
      expect(markdown).toContain("| Midterm | 25% | Oct 14 |");
      expect(markdown).toContain("| Final | 45% | Dec 12 |");
    });

    it("emits a delimiter row for a table with no <th> header", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<table><tr><td>Week 1</td><td>Intro</td></tr><tr><td>Week 2</td><td>Pointers</td></tr></table>"
      );
      const lines = markdown.trim().split("\n");
      expect(lines[0]).toBe("| Week 1 | Intro |");
      expect(lines[1]).toBe("| --- | --- |");
      expect(lines[2]).toBe("| Week 2 | Pointers |");
    });

    it("escapes a pipe inside a cell so it cannot split the row", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<table><tr><th>Grade</th></tr><tr><td>A | B</td></tr></table>"
      );
      expect(markdown).toContain("| A \\| B |");
    });

    it("flattens a multi-line cell instead of breaking the table", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<table><tr><th>Policy</th></tr><tr><td><p>No late work.</p><p>Ask first.</p></td></tr></table>"
      );
      expect(markdown).toContain("| No late work. Ask first. |");
    });

    it("scopes the delimiter row to the nested table too", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<table><tr><td>outer</td><td><table><tr><td>inner a</td><td>inner b</td></tr></table></td></tr></table>"
      );
      expect(markdown).toContain("inner a");
      expect(markdown).toContain("inner b");
      expect(markdown).not.toContain("undefined");
    });

    it("drops an empty table rather than emitting stray pipes", () => {
      expect(convertHtmlToMarkdown("<p>hi</p><table></table>").markdown).toBe("hi");
    });
  });

  describe("non-content elements", () => {
    it("drops script and style bodies instead of printing their source", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<style>.d2l-heading { color: red; }</style><p>Read chapter 4.</p><script>window.alert(1);</script>"
      );
      expect(markdown).toBe("Read chapter 4.");
      expect(markdown).not.toContain("color: red");
      expect(markdown).not.toContain("window.alert");
    });

    it("drops a noscript fallback", () => {
      const { markdown } = convertHtmlToMarkdown(
        "<p>Video below.</p><noscript>Enable JavaScript to view this.</noscript>"
      );
      expect(markdown).not.toContain("Enable JavaScript");
    });
  });

  it("returns the original html alongside the markdown", () => {
    const html = "<p>x</p>";
    expect(convertHtmlToMarkdown(html).html).toBe(html);
  });

  /**
   * D2L appends per-session query params to in-content hrefs/srcs
   * (d2lSessionVal, d2lSecureSessionVal, a `_` cache-buster). Left alone, the
   * markdown handed to the model would echo a live session token into the
   * chat transcript.
   */
  describe("session tokens in links and images", () => {
    it("strips d2lSessionVal from a link href", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="https://x.test/doc?d2lSessionVal=abc123">doc</a>'
      );
      expect(markdown).toBe("[doc](https://x.test/doc)");
    });

    it("strips d2lSecureSessionVal from a link href", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="https://x.test/doc?d2lSecureSessionVal=xyz789">doc</a>'
      );
      expect(markdown).toBe("[doc](https://x.test/doc)");
    });

    it("strips the _ cache-buster from a link href", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="https://x.test/doc?_=1696200000000">doc</a>'
      );
      expect(markdown).toBe("[doc](https://x.test/doc)");
    });

    it("strips session params from an image src", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<img src="https://x.test/img.png?d2lSessionVal=abc123&amp;_=999" alt="diagram">'
      );
      expect(markdown).toBe("![diagram](https://x.test/img.png)");
    });

    it("preserves other query params untouched", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="https://x.test/doc?page=2&d2lSessionVal=abc123&lang=en">doc</a>'
      );
      expect(markdown).toBe("[doc](https://x.test/doc?page=2&lang=en)");
    });

    it("leaves an href with no query string unchanged", () => {
      const { markdown } = convertHtmlToMarkdown('<a href="https://x.test/doc">doc</a>');
      expect(markdown).toBe("[doc](https://x.test/doc)");
    });

    it("leaves a URL alone when its only '?' falls inside the fragment", () => {
      // "#frag?x=1" is not a query string -- the "?" here belongs to the
      // fragment, so there is nothing to strip and the URL must come through
      // untouched rather than have its fragment mangled.
      const { markdown } = convertHtmlToMarkdown(
        '<a href="https://x.test/doc#section?d2lSessionVal=abc123">doc</a>'
      );
      expect(markdown).toBe("[doc](https://x.test/doc#section?d2lSessionVal=abc123)");
    });

    it("drops a javascript: href but keeps the link text", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="javascript:alert(1)">click me</a>'
      );
      expect(markdown).toBe("click me");
      expect(markdown).not.toContain("javascript:");
    });

    it("drops a data: href but keeps the link text", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="data:text/html,<script>alert(1)</script>">click me</a>'
      );
      expect(markdown).toBe("click me");
      expect(markdown).not.toContain("data:");
    });

    it("leaves a relative href as-is", () => {
      const { markdown } = convertHtmlToMarkdown(
        '<a href="/content/enforced/123-course/syllabus.pdf?d2lSessionVal=abc123">syllabus</a>'
      );
      expect(markdown).toBe(
        "[syllabus](/content/enforced/123-course/syllabus.pdf)"
      );
    });
  });
});

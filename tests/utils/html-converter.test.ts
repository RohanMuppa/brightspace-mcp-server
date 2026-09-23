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
});

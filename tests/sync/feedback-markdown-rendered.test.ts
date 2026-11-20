import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { renderFeedbackMarkdown, type FeedbackDocInput } from "../../src/sync/feedback-markdown.js";

/**
 * The produced feedback.md is rendered by a real Markdown engine, the way a viewer would, with the options
 * that make it most permissive (raw HTML on, bare addresses turned into links). Whatever remote text says,
 * the rendered page must hold no link, no image, no raw element, and the same structure the server wrote.
 */
const engine = new MarkdownIt({ html: true, linkify: true });
// Fuzzy bare-domain links ("evil.com") are an engine-specific extra, not CommonMark or GFM, and mainstream viewers
// (GitHub, VS Code, Obsidian) do not make them. feedback.md leaves decimals, abbreviations and file names alone and
// does not defend against that one extra. Every other link the engine can make (schemes, www., emails) is checked.
engine.linkify.set({ fuzzyLink: false });

const ch = (...codes: number[]) => codes.map((c) => String.fromCharCode(c)).join("");
const LS = ch(0x2028);
const PS = ch(0x2029);
const NEL = ch(0x85);

const payloads: string[] = [
  // links, images, autolinks, references
  "[click](javascript:alert(1))", "![x](http://evil/p.png)", "![x](https://evil.example/t.png \"title\")", "[a](http://x 'title')", "[a](<b>)", "[a](b", "[a]\n(b)",
  "[a][b]\n\n[b]: http://evil", "[a]: http://evil", "[x]\n[x]: <http://e>", "![a][1]\n\n[1]: http://evil/p.png", "![a]", "[a]", "[[a]](b)", "![a![b](http://e/p.png)](http://e/q.png)",
  "![a]b](http://e/p.png)", "[x\\](http://evil.com)", "[x]( http://evil.com )", "[x](<http://evil.com>)", "[![alt](https://evil.example/i.png)](https://evil.example/l)",
  "<http://evil.com>", "<someone@example.com>", "<mailto:a@b.c>", "(http://evil.com)", "*http://evil.com*", "_www.evil.com_", "~www.evil.com~", "\"http://evil.com\"",
  // bare addresses, every scheme and case
  "http://evil.com", "https://evil.com", "ftp://evil.com", "www.evil.com", "FTP://x.y", "Http://evil.com", "HTTPS://EVIL.COM", "https://x.y/a_b_c", "mailto:a@b.c", "xmpp:a@b.c",
  "a@b.com", "ME@EVIL.COM", "mail me a@b.com", "foo@bar.com", "//evil.com", "//localhost", "http://localhost", "http://127.0.0.1/x", "evil.com", "sub.evil.co.uk/path?q=1#f", "hxxp://x", "git://evil.com/x",
  // link text and alt text that are themselves addresses
  "[http://evil.com](x)", "[www.evil.com](x)", "[a@b.com](x)", "![http://evil.com](x)", "![a@b.com](x)", "[https://evil.com](https://evil.com)",
  // entity-encoded forms
  "&#91;a&#93;(http://x)", "&lt;img src=x&gt;", "&#104;ttp://evil.com", "&#x68;ttp://evil.com", "http&#58;//evil.com", "http&colon;//evil.com", "&amp;#91;", "&lt;a href=x&gt;", "&#60;img src=x&#62;", "&NewLine;# head", "&#35; head",
  // raw HTML and comments
  "<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<a href=x>go</a>", "<!-- --> -->", "<!--", "-->", "<b>bold</b>", "<iframe src=//evil></iframe>", "<style>x{}</style>", "<div>", "</div>", "<br>", "<hr>", "<table><tr><td>x", "<svg onload=x>", "<?php x ?>", "<![CDATA[x]]>", "<!DOCTYPE html>",
  // backticks and code
  "`x`", "a ` b http://evil.com c", "`x http://evil.com", "``http://evil.com`", "a`b`c http://evil.com", "```\nfoo\n```", "~~~\ncode", "```js\n[a](http://e)\n```", "``` ", "`", "``",
  // block syntax at the start of a line
  "# h", "## h", "ok\n # Heading", "title\n===", "title\n---", "---", "===", "***", "___", "  ---  ", "- Score: 100 / 100", "x\n\n- Score: 100", "line1\n\n- Status: forged", "Status: graded",
  "+ item", "* item", "- item", "1. item", "1) item", "10. item", "> quote", ">> q", ">", "| a | b |", "| a | b |\n|---|---|\n| c | d |", "    code", "\t# tab", "\tcode", "   # three", "$ x", "[^1]\n\n[^1]: note", "term\n: def",
  // line breaks and odd whitespace
  "\r\n# head\r\n", "x\r# head", "x # head", `a${LS}# head`, `a${PS}- Score: 100`, `a${NEL}# head`, "a\u000b# head", "a\u000c# head", "a\n\n\n\n# head", "trailing  \nspaces  ", "tabs\tinside\t# no",
  // escapes and odd characters
  "\\[a](b)", "\\\\[a](b)", "[a](b\\)", "\\", "\\\\", "**bold**", "$$x$$", "a | b", "a\\|b", "a > b", "&", "&&", "&nbsp;", "%", "{{x}}",
  // invisible characters inside addresses and words
  `h${ch(0x200b)}ttp://evil.com`, `ht${ch(0x200d)}tp://evil.com`, `http${ch(0xad)}://evil.com`, `w${ch(0x200b)}ww.evil.com`, `a${ch(0x202e)}b@c.com`, `\u0000http://evil.com`,
  // more shapes: truncated constructs, spaced rules, odd starts, names and domains in other scripts
  "[a](b)(c)", "![a](b)![c](d)", "ends [a](", "ends ![a", "ends http://x", "text [a](b", "[a\\](b)", "\\\\[a](b)", "* * *", "_ _ _", "- - -", "1.", "2) x", "> > x", "#", "#hashtag", "##", "####### seven",
  "<", ">", "<<", "<a", "<http", "http://", "http:", "www.", "www", "a@", "@b", "@", "x.y", "x.com.", "a.b.c.d.e", "ünï.com", "例え.jp", "1.2.3.4", "[1.2.3.4](x)", "evil.com/path/to/file.pdf", "x/evil.com", "/evil.com", " evil.com",
  "(evil.com)", "evil.com,", "<evil.com>", "\"evil.com\"", "&amp;evil.com", "\\evil.com", "|evil.com", "[evil.com]", "evil.com:8080", "user:pass@evil.com", "javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "tel:123", "sms:123",
  "notes.py", "run.sh", "a.zip", "a.md", "see evil.com and www.x.org or me@x.io", "a//b", "a///b", "http:///x", "a.b/c", "a. b", "e.g. this", "v1.2.3",
  // cut in the middle of a construct at the caps
  `${"x".repeat(199_990)}[a](http://evil.com/x)`,
  `${"x".repeat(199_995)}![a](http://evil.com/p.png)`,
  `${"x".repeat(199_998)}<img src=x>`,
  `${"x".repeat(199_999)}http://evil.com`,
  `${"x".repeat(299)}[a](http://evil.com)`,
  `${"x".repeat(296)}![a](http://evil.com/p.png)`,
  `${"x".repeat(290)} http://evil.com`,
  `${`${"é".repeat(99)}\n`.repeat(1500)}[a](http://evil.com)`,
];

interface Slot {
  name: string;
  /** Build a document with `value` in this one place and a harmless word everywhere else. */
  doc: (value: string) => FeedbackDocInput;
}

const BENIGN = "fine";
const baseDoc = (): FeedbackDocInput => ({
  folderId: 7,
  name: "Essay",
  isGroup: false,
  due: "2026-10-02T23:59:00Z",
  points: 20,
  submissions: { known: true, items: [{ date: "2026-10-02T21:10:00Z", by: "A. Student" }] },
  files: ["my files/Essay.docx"],
  filesNotSaved: { failed: 1, empty: 1, notYet: 1 },
  feedback: {
    known: true,
    score: 18,
    text: "Good thesis.",
    released: true,
    rubrics: [{ name: "Rubric", overall: { score: 3, levelName: "Good", feedback: "Overall fine" }, criteria: [{ criterionName: "Thesis", levelName: "Level 3", score: 3, feedback: "Clear" }] }],
  },
  feedbackFiles: ["feedback files/Marked-up.pdf"],
  feedbackFilesNotSaved: { failed: 1, empty: 0, notYet: 0 },
  assignmentFiles: ["assignment files/Prompt.pdf"],
  assignmentFilesNotSaved: { failed: 0, empty: 1, notYet: 0 },
});

const withFeedback = (change: (f: Extract<FeedbackDocInput["feedback"], { known: true }>) => void): FeedbackDocInput => {
  const doc = baseDoc();
  change(doc.feedback as Extract<FeedbackDocInput["feedback"], { known: true }>);
  return doc;
};
const criterion = (field: "criterionName" | "levelName" | "feedback") => (value: string) =>
  withFeedback((f) => { f.rubrics[0].criteria[0][field] = value; });

const slots: Slot[] = [
  { name: "text, alone on a line", doc: (v) => withFeedback((f) => { f.text = v; }) },
  { name: "text, at the start of a line", doc: (v) => withFeedback((f) => { f.text = `${v} and then more`; }) },
  { name: "text, mid-line", doc: (v) => withFeedback((f) => { f.text = `before ${v} after`; }) },
  { name: "text, at the end of a line", doc: (v) => withFeedback((f) => { f.text = `before ${v}`; }) },
  { name: "text, on a later line", doc: (v) => withFeedback((f) => { f.text = `first line\n${v}\nlast line`; }) },
  { name: "text, after a blank line, with CRLF", doc: (v) => withFeedback((f) => { f.text = `first\r\n\r\n${v}\r\nlast`; }) },
  { name: "rubric criterion", doc: criterion("criterionName") },
  { name: "rubric level", doc: criterion("levelName") },
  { name: "rubric comment", doc: criterion("feedback") },
  { name: "rubric overall comment", doc: (v) => withFeedback((f) => { f.rubrics[0].overall!.feedback = v; }) },
  { name: "rubric overall level", doc: (v) => withFeedback((f) => { f.rubrics[0].overall!.levelName = v; }) },
  { name: "rubric name", doc: (v) => withFeedback((f) => { f.rubrics[0].name = v; }) },
  { name: "assignment name", doc: (v) => ({ ...baseDoc(), name: v }) },
  { name: "submitter", doc: (v) => ({ ...baseDoc(), submissions: { known: true, items: [{ date: "2026-10-02T21:10:00Z", by: v }] } }) },
  { name: "submission date", doc: (v) => ({ ...baseDoc(), submissions: { known: true, items: [{ date: v, by: "A. Student" }] } }) },
  { name: "due date", doc: (v) => ({ ...baseDoc(), due: v }) },
  { name: "submission file name", doc: (v) => ({ ...baseDoc(), files: [`my files/${v}`] }) },
  { name: "feedback file name", doc: (v) => ({ ...baseDoc(), feedbackFiles: [`feedback files/${v}`] }) },
  { name: "assignment file name", doc: (v) => ({ ...baseDoc(), assignmentFiles: [`assignment files/${v}`] }) },
  { name: "unknown submissions reason", doc: (v) => ({ ...baseDoc(), submissions: { known: false, reason: v } }) },
  { name: "unknown files reason", doc: (v) => ({ ...baseDoc(), filesUnknown: v }) },
  { name: "unknown feedback reason", doc: (v) => ({ ...baseDoc(), feedback: { known: false, reason: v }, feedbackFiles: { known: false, reason: v } }) },
  { name: "unknown assignment files reason", doc: (v) => ({ ...baseDoc(), assignmentFiles: { known: false, reason: v } }) },
];

const ALLOWED = new Set(["h1", "h2", "ul", "li", "p", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "em", "strong", "s", "br"]);
const STRUCTURE = ["h1", "h2", "ul", "li", "blockquote", "table", "tr", "th", "td"];

const tagCounts = (html: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)/g)) {
    if (match[0].startsWith("</")) continue;
    counts.set(match[1].toLowerCase(), (counts.get(match[1].toLowerCase()) ?? 0) + 1);
  }
  return counts;
};

describe("the rendered feedback.md", () => {
  const control = new Map<string, Map<string, number>>();
  for (const slot of slots) control.set(slot.name, tagCounts(engine.render(renderFeedbackMarkdown(slot.doc(BENIGN)))));

  it("has a matrix of real size", () => {
    expect(payloads.length * slots.length).toBeGreaterThan(5000);
  });

  it("the control documents render to the structure the server writes", () => {
    const counts = control.get("text, alone on a line")!;
    expect(counts.get("h1")).toBe(1);
    expect(counts.get("table")).toBe(1);
    expect(counts.get("a")).toBeUndefined();
    expect(counts.get("img")).toBeUndefined();
  });

  for (const slot of slots) {
    it(`stays inert and keeps its structure with remote text in: ${slot.name}`, () => {
      const expected = control.get(slot.name)!;
      const problems: string[] = [];
      for (const payload of payloads) {
        const markdown = renderFeedbackMarkdown(slot.doc(payload));
        const html = engine.render(markdown);
        const counts = tagCounts(html);
        // A cut drops whatever lies past it, so its structure is compared only when nothing was cut.
        const cut = markdown.includes("was cut here");
        const label = JSON.stringify(payload.length > 60 ? `${payload.slice(0, 20)}...(${payload.length} chars)...${payload.slice(-20)}` : payload);
        for (const tag of counts.keys()) {
          if (!ALLOWED.has(tag)) problems.push(`${label}: rendered <${tag}>`);
        }
        for (const tag of cut ? [] : STRUCTURE) {
          if ((counts.get(tag) ?? 0) !== (expected.get(tag) ?? 0)) problems.push(`${label}: <${tag}> ${counts.get(tag) ?? 0}, expected ${expected.get(tag) ?? 0}`);
        }
        if (/<a[\s>]/i.test(html) || /<img/i.test(html)) problems.push(`${label}: a live link or image`);
        // Our own header comment is the only comment, and it is not closed or reopened by anything remote.
        if ((markdown.match(/<!--/g) ?? []).length !== 1 || (markdown.match(/-->/g) ?? []).length !== 1) problems.push(`${label}: comment markers in the file`);
        if (/<[^>]*\s(?:href|src)\s*=/i.test(html)) problems.push(`${label}: an attribute that fetches`);
      }
      expect(problems.slice(0, 10)).toEqual([]);
    });
  }
});

import { describe, it, expect } from "vitest";
import { assignmentUrl, quizUrl } from "../../src/utils/deep-links.js";

const BASE = "https://brightspace.example.edu";

describe("deep-links", () => {
  it("builds the dropbox submit-files url", () => {
    expect(assignmentUrl(BASE, 12345, 678)).toBe(
      "https://brightspace.example.edu/d2l/lms/dropbox/user/folder_submit_files.d2l?db=678&grpid=0&ou=12345"
    );
  });

  it("builds the quiz summary url", () => {
    expect(quizUrl(BASE, 12345, 91)).toBe(
      "https://brightspace.example.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=91&ou=12345"
    );
  });

  it("strips a trailing slash from baseUrl", () => {
    expect(assignmentUrl(`${BASE}/`, 1, 2)).toBe(
      "https://brightspace.example.edu/d2l/lms/dropbox/user/folder_submit_files.d2l?db=2&grpid=0&ou=1"
    );
    expect(quizUrl(`${BASE}/`, 1, 2)).toBe(
      "https://brightspace.example.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1"
    );
  });
});

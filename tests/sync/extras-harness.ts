import { vi } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { fakeBrightspace, type Fake, type Step } from "./harness.js";

const LE = "/d2l/api/le/1.99/42";

/** Routes of course 42 as the fake Brightspace serves them. */
export const route = (suffix: string): string => `${LE}${suffix}`;

export const folder = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: name,
  IsHidden: false,
  GroupTypeId: null,
  DueDate: "2026-10-02T23:59:00Z",
  Assessment: { ScoreDenominator: 20, Rubrics: [] },
  Attachments: [],
  ...extra,
});

export const submission = (id: number, files: Array<{ FileId: number; FileName: string; Size?: number }>, by = "A. Student", date = "2026-10-02T21:10:00Z") => ({
  Id: id,
  SubmittedBy: { Identifier: "5", DisplayName: by },
  SubmissionDate: date,
  Comment: null,
  Files: files.map((f) => ({ Size: 10, ...f })),
});

export const news = (id: number, title: string, attachments: Array<{ FileId: number; FileName: string; Size?: number }> | null, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Title: title,
  Body: null,
  IsPublished: true,
  StartDate: "2026-10-01T12:00:00Z",
  CreatedDate: "2026-09-30T12:00:00Z",
  Attachments: attachments === null ? null : attachments.map((a) => ({ Size: 10, ...a })),
  ...extra,
});

export const status = (code: number) => new ApiError(code, "/x", "refused");

export interface Extras {
  /** Answers of `client.get` by route (a value, or an Error to throw). */
  routes: Record<string, unknown>;
  /** What `client.getRaw` serves by route, besides content topics. */
  files: Record<string, Step | Step[]>;
}

/**
 * The content fake plus assignment and announcement routes. The route table is
 * live: a test can change `extras.routes` or `extras.files` between two runs.
 */
export async function fakeCourse(toc: unknown, topics: Record<number, Step | Step[]>, extras: Extras): Promise<Fake & { rawRequests: string[] }> {
  const routes = extras.routes;
  const base = await fakeBrightspace(toc, topics, {});
  const contentGet = base.client.get;
  base.client.lp = (p: string) => `/d2l/api/lp/1.99${p}`;
  base.client.get = vi.fn(async (p: string, options?: unknown) => {
    if (p in routes) {
      const hit = routes[p];
      if (hit instanceof Error) throw hit;
      return hit;
    }
    return contentGet(p, options);
  });
  const contentRaw = base.client.getRaw;
  const rawRequests: string[] = [];
  const counts = new Map<string, number>();
  base.client.getRaw = vi.fn(async (p: string, options?: unknown) => {
    if (/\/content\/topics\/\d+\/file/.test(p)) return contentRaw(p, options);
    rawRequests.push(p);
    const plan = extras.files[p];
    const steps = Array.isArray(plan) ? plan : [plan];
    const n = counts.get(p) ?? 0;
    counts.set(p, n + 1);
    const step = steps[Math.min(n, steps.length - 1)];
    if (!step) throw new ApiError(404, p, "not found");
    if ("error" in step) throw step.error;
    if ("status" in step) throw new ApiError(step.status, p, "refused");
    if ("short" in step) throw new Error("short bodies are not supported here");
    return new Response(new Uint8Array(step.body), {
      headers: { "Content-Type": "application/pdf", "Content-Length": String(step.body.length) },
    });
  });
  return Object.assign(base, { rawRequests });
}

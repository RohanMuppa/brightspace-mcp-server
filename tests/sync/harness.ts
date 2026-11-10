import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { ApiError, RateLimitError } from "../../src/api/errors.js";

/** A small valid PDF whose bytes differ per `tag`, so file sizes can differ. */
export const pdf = (tag = "", pad = 64): Buffer =>
  Buffer.concat([Buffer.from(`%PDF-1.4\n${tag}\n`), Buffer.alloc(pad)]);

export const fileTopic = (id: number, url: string | null, extra: Record<string, unknown> = {}) => ({
  TopicId: id,
  Title: `Topic ${id}`,
  TypeIdentifier: "File",
  TopicType: 1,
  Url: url,
  IsBroken: false,
  ...extra,
});

export const module_ = (id: number, title: string, topics: unknown[] = [], modules: unknown[] = []) => ({
  ModuleId: id,
  Title: title,
  Topics: topics,
  Modules: modules,
});

/** What the fake Brightspace does when a topic's file is requested, in order; the last entry repeats. */
export type Step =
  | { body: Buffer; disposition?: string }
  | { status: number; retryAfter?: number }
  | { short: true; body: Buffer }
  | { error: Error };

export interface Fake {
  client: any;
  requests: Map<number, number>;
  tocReads: () => number;
  close: () => Promise<void>;
}

/**
 * A stand-in for the API client over a local HTTP server. The real client
 * insists on https, so this reproduces what it hands a tool: a Response for a
 * served file and an ApiError / RateLimitError for a refusal.
 */
export async function fakeBrightspace(toc: unknown, topics: Record<number, Step | Step[]>, extra: Record<string, unknown> = {}): Promise<Fake> {
  const requests = new Map<number, number>();
  let tocReads = 0;
  const server = http.createServer((req, res) => {
    const body = (shortBodies.get(req.url ?? "") ?? Buffer.alloc(0));
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(body.length * 2) });
    res.write(body, () => res.socket?.destroy());
  });
  const shortBodies = new Map<string, Buffer>();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = {
    origin: "https://school.brightspace.test",
    le: (id: number, p: string) => `/d2l/api/le/1.99/${id}${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith("/content/toc")) {
        tocReads++;
        return toc;
      }
      const override = extra[p];
      if (override instanceof Error) throw override;
      if (override !== undefined) return override;
      throw new ApiError(404, p, "not found");
    }),
    getRaw: vi.fn(async (p: string) => {
      const id = Number(/topics\/(\d+)\/file/.exec(p)?.[1]);
      const n = requests.get(id) ?? 0;
      requests.set(id, n + 1);
      const plan = topics[id];
      const steps = Array.isArray(plan) ? plan : [plan];
      const step = steps[Math.min(n, steps.length - 1)];
      if (!step) throw new ApiError(404, p, "File not found");
      if ("error" in step) throw step.error;
      if ("status" in step) {
        if (step.status === 429) throw new RateLimitError(p, step.retryAfter);
        throw new ApiError(step.status, p, "refused");
      }
      if ("short" in step) {
        const route = `/short/${id}/${n}`;
        shortBodies.set(route, step.body);
        return fetch(`${base}${route}`);
      }
      return new Response(new Uint8Array(step.body), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(step.body.length),
          ...(step.disposition ? { "Content-Disposition": step.disposition } : {}),
        },
      });
    }),
  };
  return {
    client,
    requests,
    tocReads: () => tocReads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "course-sync-"));
}

/** Every file under `dir`, relative, with forward slashes, sorted. */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      // The sync's own bookkeeping, covered by its own tests.
      if (!prefix && (entry.name === ".brightspace-sync.json" || entry.name === ".brightspace-sync.lock")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        await walk(path.join(current, entry.name), rel);
      } else out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

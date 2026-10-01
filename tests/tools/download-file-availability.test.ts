import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiError } from "../../src/api/errors.js";
import { registerDownloadFile } from "../../src/tools/download-file.js";

const future = "2099-01-01T09:00:00Z";
const past = "2000-01-01T09:00:00Z";

let downloadPath: string;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  downloadPath = await fs.mkdtemp(path.join(os.tmpdir(), "download-file-availability-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(downloadPath, { recursive: true, force: true });
});

function harness(options: { status?: number; metadata?: unknown; metadataError?: Error; toc?: unknown; tocError?: Error; rawError?: Error } = {}) {
  const client = {
    le: (id: number, p: string) => `/d2l/api/le/1.99/${id}${p}`,
    getRaw: vi.fn(async () => { throw options.rawError ?? new ApiError(options.status ?? 404, '/file', 'Unavailable'); }),
    get: vi.fn(async (p: string) => {
      if (p.endsWith('/content/topics/101')) {
        if (options.metadataError) throw options.metadataError;
        return options.metadata ?? null;
      }
      if (p.endsWith('/content/toc')) {
        if (options.tocError) throw options.tocError;
        return options.toc ?? { Modules: [] };
      }
      throw new Error('Unexpected metadata route');
    }),
  };
  let handler: any;
  registerDownloadFile({ registerTool: (_n: string, _m: unknown, f: any) => { handler = f; } } as never, client as never);
  return {
    client,
    call: async () => {
      const response = await handler({ courseId: 42, topicId: 101, downloadPath });
      return { response, data: response.isError ? { message: response.content[0].text } : JSON.parse(response.content[0].text) };
    },
  };
}

const toc = (topic: unknown) => ({ Modules: [{ Topics: [topic] }] });

describe('unavailable file explanations', () => {
  it.each([403, 404])('recognizes a future topic from the TOC after HTTP %s', async (status) => {
    const h = harness({ status, metadataError: new ApiError(403, '/topic', 'Forbidden'), toc: toc({ TopicId: 101, Title: 'Fixture file', StartDateTime: future }) });
    const { response, data } = await h.call();
    expect(response.isError).toBeUndefined();
    expect(data).toMatchObject({ success: false, available: false, reason: 'not_yet_open', startDate: future, endDate: null });
    expect(data.message).toContain('available from');
    expect(h.client.get).toHaveBeenCalledWith('/d2l/api/le/1.99/42/content/toc', expect.anything());
  });

  it('uses direct release metadata if the TOC is unavailable', async () => {
    const { data } = await harness({ metadata: { Id: 101, StartDate: future }, tocError: new ApiError(403, '/toc', 'Forbidden') }).call();
    expect(data.reason).toBe('not_yet_open');
  });

  it('finds TOC restrictions even when direct metadata has no release date', async () => {
    const { data } = await harness({ metadata: { Id: 101 }, toc: toc({ TopicId: 101, Title: 'TOC title', StartDateTime: future }) }).call();
    expect(data).toMatchObject({ reason: 'not_yet_open', startDate: future, title: 'TOC title' });
  });

  it.each([
    [{ EndDateTime: past }, 'ended'],
    [{ IsLocked: true }, 'locked'],
    [{ IsHidden: true }, 'hidden'],
  ])('explains the specific topic restriction: %j', async (flags, reason) => {
    const { response, data } = await harness({ toc: toc({ Identifier: '101', ...flags }) }).call();
    expect(response.isError).toBeUndefined();
    expect(data.reason).toBe(reason);
  });

  it.each([
    [{ StartDateTime: future }, 'not_yet_open'],
    [{ EndDateTime: past }, 'ended'],
    [{ IsLocked: true }, 'locked'],
  ])('inherits a nested module restriction: %j', async (flags, reason) => {
    const { data } = await harness({ toc: { Modules: [{ ...flags, Modules: [{ Topics: [{ TopicId: 101 }] }] }] } }).call();
    expect(data.reason).toBe(reason);
  });

  it('preserves the original access-denied error when metadata says the topic is available', async () => {
    const { response, data } = await harness({ status: 403, metadata: { Id: 101, Title: 'Known topic' } }).call();
    expect(response.isError).toBe(true);
    expect(data.reason).toBeUndefined();
    expect(data.message).toContain('Access denied');
  });

  it.each([
    { toc: { Modules: [] } },
    { metadata: { Id: 101 }, toc: toc({ TopicId: 101 }) },
    { toc: null },
    { toc: { Modules: 'malformed' } },
  ])('preserves a missing-file error when no availability restriction is established: %j', async (options) => {
    const { response, data } = await harness(options).call();
    expect(response.isError).toBe(true);
    expect(data.reason).toBeUndefined();
  });

  it('does not promise a downloadable file for an unreleased quiz or link', async () => {
    const { response } = await harness({ toc: toc({ TopicId: 101, TypeIdentifier: 'Quiz', StartDateTime: future }) }).call();
    expect(response.isError).toBe(true);
  });

  it('does not claim a topic exists when both metadata routes deny access', async () => {
    const { response, data } = await harness({ status: 403, metadataError: new ApiError(403, '/topic', 'Forbidden'), tocError: new ApiError(403, '/toc', 'Forbidden') }).call();
    expect(response.isError).toBe(true);
    expect(data.reason).toBeUndefined();
  });

  it('does not hide an unexpected metadata failure behind an availability explanation', async () => {
    const h = harness({ metadataError: new ApiError(500, '/topic', 'Server error'), toc: toc({ TopicId: 101, StartDateTime: future }) });
    expect((await h.call()).response.isError).toBe(true);
    expect(h.client.get).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 500])('does not reinterpret other file errors: HTTP %s', async (status) => {
    const h = harness({ status, toc: toc({ TopicId: 101, StartDateTime: future }) });
    expect((await h.call()).response.isError).toBe(true);
    expect(h.client.get).not.toHaveBeenCalled();
  });

  it('does not reinterpret a transport failure', async () => {
    const h = harness({ rawError: new Error('connection failed') });
    expect((await h.call()).response.isError).toBe(true);
    expect(h.client.get).not.toHaveBeenCalled();
  });
});

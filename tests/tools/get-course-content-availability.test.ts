import { describe, expect, it, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";

function harness(moduleFlags: object = {}, topicFlags: object = {}) {
  const topic = { Id: 101, Type: 1, TopicType: 1, Title: 'Fixture file', LastModifiedDate: '2030-01-02T00:00:00Z', ...topicFlags };
  const module = { Id: 100, Type: 0, Title: 'Fixture module', LastModifiedDate: '2029-01-01T00:00:00Z', ...moduleFlags };
  const client = {
    le: (id: number, p: string) => `/d2l/api/le/1.99/${id}${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith('/content/root/')) return [module];
      if (p.endsWith('/content/modules/100/structure/')) return [topic];
      if (p.endsWith('/content/userprogress/')) return [];
      throw new Error('Unexpected content route');
    }),
  };
  let handler: any;
  registerGetCourseContent({ registerTool: (_n: string, _m: unknown, f: any) => { handler = f; } } as never, client as never);
  return async (args: object = {}) => {
    const response = await handler({ courseId: 42, ...args });
    expect(response.isError).toBeUndefined();
    return JSON.parse(response.content[0].text);
  };
}

describe('course content release windows', () => {
  it('omits availability fields for available modules and topics, matching isHidden/isLocked', async () => {
    const data = await harness()();
    for (const item of [data.contentTree[0], data.contentTree[0].children[0]]) {
      expect(item.isAvailable).toBeUndefined();
      expect(item.availabilityStatus).toBeUndefined();
      expect(item.availabilityMessage).toBeUndefined();
      expect(item.startDate).toBeUndefined();
      expect(item.endDate).toBeUndefined();
    }
  });

  it('propagates the module release date to an otherwise undated topic', async () => {
    const data = await harness({ ModuleStartDate: '2099-01-01T00:00:00Z' })();
    expect(data.contentTree[0]).toMatchObject({ isAvailable: false, availabilityStatus: 'not_yet_open' });
    expect(data.contentTree[0].children[0]).toMatchObject({ isAvailable: false, availabilityStatus: 'not_yet_open', startDate: '2099-01-01T00:00:00Z' });
  });

  it('keeps availability information when modifiedSince selects a child', async () => {
    const data = await harness({ ModuleEndDate: '2000-01-01T00:00:00Z' })({ modifiedSince: '2030-01-01T00:00:00Z' });
    expect(data.contentTree).toHaveLength(1);
    expect(data.contentTree[0].children).toHaveLength(1);
    expect(data.contentTree[0].children[0]).toMatchObject({ availabilityStatus: 'ended', endDate: '2000-01-01T00:00:00Z' });
  });

  it('keeps a topic-specific window inside an available module', async () => {
    const data = await harness({}, { StartDate: '2099-02-01T00:00:00Z' })();
    expect(data.contentTree[0].isAvailable).toBeUndefined();
    expect(data.contentTree[0].children[0].availabilityStatus).toBe('not_yet_open');
  });
});

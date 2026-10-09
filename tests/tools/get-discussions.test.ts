import { describe, it, expect, vi } from "vitest";
import { registerGetDiscussions } from "../../src/tools/get-discussions.js";

/**
 * get_discussions drops deleted posts from `posts`, so `postCount` must be
 * counted after that filter or it promises posts the response never shows.
 */

const COURSE_ID = 55;
const FORUM_ID = 30;
const TOPIC_ID = 40;

const LE_PREFIX = "/d2l/api/le/1.90";
const FORUM_PATH = `${LE_PREFIX}/${COURSE_ID}/discussions/forums/${FORUM_ID}`;
const TOPICS_PATH = `${FORUM_PATH}/topics/`;
const TOPIC_PATH = `${FORUM_PATH}/topics/${TOPIC_ID}`;
const POSTS_PATH = `${TOPIC_PATH}/posts/`;

const FORUM = {
  ForumId: FORUM_ID,
  Name: "General",
  Description: null,
  StartDate: null,
  EndDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymous: false,
  RequiresApproval: false,
};

const TOPIC = {
  ForumId: FORUM_ID,
  TopicId: TOPIC_ID,
  Name: "Introductions",
  Description: null,
  StartDate: null,
  EndDate: null,
  DueDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymousPosts: false,
  MustPostToParticipate: false,
  RequiresApproval: false,
  ScoreOutOf: null,
};

const post = (id: number, isDeleted: boolean) => ({
  ForumId: FORUM_ID,
  TopicId: TOPIC_ID,
  PostId: id,
  ThreadId: id,
  ParentPostId: null,
  Subject: `Post ${id}`,
  Message: { Text: `Body ${id}`, Html: "" },
  PostingUserId: 1,
  PostingUserDisplayName: "Ada Lovelace",
  DatePosted: `2026-09-0${id}T12:00:00.000Z`,
  IsAnonymous: false,
  IsDeleted: isDeleted,
  LastEditedDate: null,
  ReplyPostIds: [],
  WordCount: 2,
  AttachmentCount: 0,
  IsRead: true,
});

const POSTS = [post(1, false), post(2, true), post(3, false)];

function setup() {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `${LE_PREFIX}/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path === FORUM_PATH) return FORUM;
      if (path === TOPICS_PATH) return [TOPIC];
      if (path === TOPIC_PATH) return TOPIC;
      if (path === POSTS_PATH) return POSTS;
      throw new Error(`Unexpected path requested: ${path}`);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetDiscussions(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_discussions postCount", () => {
  it("counts only the non-deleted posts returned for a topic", async () => {
    const { call } = setup();

    const payload = parse(await call({ courseId: COURSE_ID, forumId: FORUM_ID, topicId: TOPIC_ID }));

    expect(payload.posts.map((p: any) => p.postId)).toEqual([1, 3]);
    expect(payload.postCount).toBe(2);
  });

  it("counts only the non-deleted posts returned for each topic of a forum", async () => {
    const { call } = setup();

    const payload = parse(await call({ courseId: COURSE_ID, forumId: FORUM_ID }));

    expect(payload.topics).toHaveLength(1);
    const [topic] = payload.topics;
    expect(topic.posts.map((p: any) => p.postId)).toEqual([1, 3]);
    expect(topic.postCount).toBe(2);
  });
});

import { describe, it, expect, vi } from "vitest";
import { registerGetDiscussions } from "../../src/tools/get-discussions.js";
import { ApiError } from "../../src/api/errors.js";

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

/**
 * Issue #364: a student can list a topic through its forum's topic list yet be
 * refused the per-topic metadata route. The topic read must take its metadata
 * from the list it was found in, and a refused posts read must come back as
 * partial coverage that says which step failed, not as an empty topic.
 */
function forbidden(path: string) {
  return Object.assign(new Error(`403 at ${path}`), { status: 403 });
}

function setupWith(
  routes: Record<string, () => unknown>,
  baseUrl?: string
) {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `${LE_PREFIX}/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      const route = routes[path];
      if (!route) throw new Error(`Unexpected path requested: ${path}`);
      return route();
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetDiscussions(server as any, apiClient as any, baseUrl);
  return { call: (args: unknown) => handler!(args) };
}

const TOPIC_ARGS = { courseId: COURSE_ID, forumId: FORUM_ID, topicId: TOPIC_ID };

describe("get_discussions topic read (#364)", () => {
  it("reads a topic whose per-topic metadata route is forbidden but which its forum lists", async () => {
    const { call } = setupWith({
      [TOPICS_PATH]: () => [TOPIC],
      [TOPIC_PATH]: () => { throw forbidden(TOPIC_PATH); },
      [POSTS_PATH]: () => POSTS,
    });

    const result = await call(TOPIC_ARGS);

    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.topic.name).toBe("Introductions");
    expect(payload.posts.map((p: any) => p.postId)).toEqual([1, 3]);
  });

  it("falls back to the per-topic route when the forum's list does not include the topic", async () => {
    const { call } = setupWith({
      [TOPICS_PATH]: () => [],
      [TOPIC_PATH]: () => TOPIC,
      [POSTS_PATH]: () => POSTS,
    });

    const payload = parse(await call(TOPIC_ARGS));

    expect(payload.topic.topicId).toBe(TOPIC_ID);
    expect(payload.postCount).toBe(2);
  });

  it("returns the topic with posts marked unavailable, not empty, when the posts read is forbidden", async () => {
    const { call } = setupWith(
      {
        [TOPICS_PATH]: () => [TOPIC],
        [POSTS_PATH]: () => { throw forbidden(POSTS_PATH); },
      },
      "https://school.example.edu/"
    );

    const result = await call(TOPIC_ARGS);

    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.topic.name).toBe("Introductions");
    expect(payload.posts).toBeNull();
    expect(payload.postCount).toBeNull();
    expect(payload.postsUnavailable).toMatchObject({
      operation: "listPosts",
      status: 403,
      url: `https://school.example.edu/d2l/le/${COURSE_ID}/discussions/topics/${TOPIC_ID}/View`,
    });
  });

  it("still fails the call when the topic's forum refuses its topic list and the topic route", async () => {
    const { call } = setupWith({
      [TOPICS_PATH]: () => { throw forbidden(TOPICS_PATH); },
      [TOPIC_PATH]: () => { throw forbidden(TOPIC_PATH); },
      [POSTS_PATH]: () => POSTS,
    });

    const result = await call(TOPIC_ARGS);

    expect(result.isError).toBe(true);
  });
});

/**
 * Issue #398: the course overview and the forum view fetch one sub-list per
 * item. A failed read there must come back as null with a reason, never as an
 * empty list, and a session that can't be used must fail the whole call.
 */
const FORUMS_PATH = `${LE_PREFIX}/${COURSE_ID}/discussions/forums/`;
const OTHER_FORUM_ID = 31;
const OTHER_FORUM = { ...FORUM, ForumId: OTHER_FORUM_ID, Name: "Q&A" };
const OTHER_TOPICS_PATH = `${FORUMS_PATH}${OTHER_FORUM_ID}/topics/`;
const OTHER_TOPIC_ID = 41;
const OTHER_TOPIC = { ...TOPIC, TopicId: OTHER_TOPIC_ID, Name: "Week 1" };
const OTHER_POSTS_PATH = `${TOPICS_PATH}${OTHER_TOPIC_ID}/posts/`;

describe("get_discussions sub-lists that couldn't be read (#398)", () => {
  it("marks a forum's topics unavailable, not empty, when its topic list fails", async () => {
    const { call } = setupWith({
      [FORUMS_PATH]: () => [FORUM, OTHER_FORUM],
      [TOPICS_PATH]: () => [TOPIC],
      [OTHER_TOPICS_PATH]: () => { throw new ApiError(500, OTHER_TOPICS_PATH, "boom"); },
    });

    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeFalsy();
    const [readable, failed] = parse(result).forums;
    expect(readable.topics).toHaveLength(1);
    expect(readable.topicsUnavailable).toBeUndefined();
    expect(failed.topics).toBeNull();
    expect(failed.topicsUnavailable).toMatchObject({ operation: "listTopics", status: 500 });
  });

  it("marks a topic's posts unavailable, not empty, in the forum view", async () => {
    const { call } = setupWith({
      [FORUM_PATH]: () => FORUM,
      [TOPICS_PATH]: () => [TOPIC, OTHER_TOPIC],
      [POSTS_PATH]: () => POSTS,
      [OTHER_POSTS_PATH]: () => { throw forbidden(OTHER_POSTS_PATH); },
    });

    const result = await call({ courseId: COURSE_ID, forumId: FORUM_ID });

    expect(result.isError).toBeFalsy();
    const [readable, failed] = parse(result).topics;
    expect(readable.postCount).toBe(2);
    expect(readable.postsUnavailable).toBeUndefined();
    expect(failed.posts).toBeNull();
    expect(failed.postCount).toBeNull();
    expect(failed.postsUnavailable).toMatchObject({ operation: "listPosts", status: 403 });
  });

  it("fails the overview when the session is unusable instead of listing empty forums", async () => {
    const { call } = setupWith({
      [FORUMS_PATH]: () => [FORUM],
      [TOPICS_PATH]: () => { throw new ApiError(401, TOPICS_PATH, "expired"); },
    });

    expect((await call({ courseId: COURSE_ID })).isError).toBe(true);
  });

  it("fails the forum view when the session is unusable instead of listing empty topics", async () => {
    const { call } = setupWith({
      [FORUM_PATH]: () => FORUM,
      [TOPICS_PATH]: () => [TOPIC],
      [POSTS_PATH]: () => { throw new ApiError(401, POSTS_PATH, "expired"); },
    });

    expect((await call({ courseId: COURSE_ID, forumId: FORUM_ID })).isError).toBe(true);
  });
});

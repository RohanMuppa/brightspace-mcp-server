import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { ApiError } from "../api/errors.js";

export interface GroupCategoryDto { GroupCategoryId: number; Name: string }
export interface GroupDto {
  GroupId: number;
  Name: string;
  Code?: string | null;
  Enrollments?: number[] | null;
}
export interface GroupMembership { category: GroupCategoryDto; group: GroupDto }

const inaccessible = (error: unknown) => error instanceof ApiError
  && (error.status === 403 || error.status === 404);

/** The signed-in user's id, from the cached whoami read. */
export async function fetchCurrentUserId(apiClient: D2LApiClient): Promise<number> {
  const me = await apiClient.get<{ Identifier: number | string }>(apiClient.lp("/users/whoami"),
    { ttl: DEFAULT_CACHE_TTLS.roster });
  const myId = Number(me.Identifier);
  if (!Number.isSafeInteger(myId) || myId <= 0) throw new Error("Brightspace returned an invalid current user identifier.");
  return myId;
}

/** Shared membership lookup. API cache/coalescing bounds repeat reads; no classlist is needed. */
export async function fetchMyGroupMemberships(apiClient: D2LApiClient, courseId: number, categoryId?: number) {
  const myId = await fetchCurrentUserId(apiClient);

  let categories: GroupCategoryDto[];
  try {
    categories = categoryId === undefined
      ? await apiClient.get<GroupCategoryDto[]>(apiClient.lp(`/${courseId}/groupcategories/`), { ttl: DEFAULT_CACHE_TTLS.roster })
      : [{ GroupCategoryId: categoryId, Name: "" }];
  } catch (error) {
    if (inaccessible(error)) {
      return { matches: [] as GroupMembership[], categoriesUnavailable: true, unreadCategories: [] as GroupCategoryDto[] };
    }
    throw error;
  }
  const matches: GroupMembership[] = [];
  // Categories whose groups answered 403/404: membership there is unknown, not "none".
  const unreadCategories: GroupCategoryDto[] = [];
  for (const category of categories) {
    let groups: GroupDto[];
    try {
      groups = await apiClient.get<GroupDto[]>(
        apiClient.lp(`/${courseId}/groupcategories/${category.GroupCategoryId}/groups/`), { ttl: DEFAULT_CACHE_TTLS.roster });
    } catch (error) {
      if (inaccessible(error)) {
        unreadCategories.push(category);
        continue;
      }
      throw error;
    }
    for (const group of groups) {
      if (group.Enrollments?.some((id) => Number(id) === myId)) matches.push({ category, group });
    }
  }
  return { matches, categoriesUnavailable: false, unreadCategories };
}

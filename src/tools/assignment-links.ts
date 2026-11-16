import type { D2LApiClient } from "../api/index.js";
import { assignmentUrl } from "../utils/deep-links.js";
import { fetchMyGroupMemberships } from "./group-membership.js";
import { isAuthUnavailable } from "./tool-helpers.js";

interface FolderLinkData { Id: number; GroupTypeId?: number | null }

/** Resolve only the folder's category, once per category per tool call. */
export function assignmentLinkResolver(apiClient: D2LApiClient, baseUrl: string | undefined, courseId: number) {
  // "unread" means the membership request was refused or failed, so whether
  // the learner has a group is unknown, not "no group" (#451).
  const groups = new Map<number, Promise<number | null | "unread">>();
  return async (folder: FolderLinkData) => {
    if (!baseUrl) return { url: null };
    // D2L defines both missing and null GroupTypeId as individual folders:
    // https://docs.valence.desire2learn.com/res/dropbox.html#Dropbox.DropboxFolder
    if (folder.GroupTypeId === null || folder.GroupTypeId === undefined) {
      return { url: assignmentUrl(baseUrl, courseId, folder.Id), urlKind: "assignment" };
    }

    const categoryId = folder.GroupTypeId;
    let groupId: number | null | "unread" = null;
    if (categoryId !== undefined && Number.isSafeInteger(categoryId) && categoryId > 0) {
      if (!groups.has(categoryId)) {
        groups.set(categoryId, (async () => {
          try {
            const { matches, unreadCategories } = await fetchMyGroupMemberships(apiClient, courseId, categoryId);
            if (matches.length === 0 && unreadCategories.length > 0) return "unread";
            const ids = [...new Set(matches.map(({ group }) => group.GroupId))]
              .filter((id) => Number.isSafeInteger(id) && id > 0);
            return ids.length === 1 ? ids[0] : null;
          } catch (error) {
            if (isAuthUnavailable(error)) throw error;
            return "unread";
          }
        })());
      }
      groupId = await groups.get(categoryId)!;
    }
    const courseHome = `${baseUrl.replace(/\/+$/, "")}/d2l/home/${courseId}`;
    if (groupId === "unread") {
      return {
        url: courseHome,
        urlKind: "course-home",
        groupMembershipUnavailable: true,
        urlNote: "Brightspace refused or failed the request for your group membership, so the server could not link to " +
          "your group's folder. This does not mean you have no group. Open Assignments from the course home to select the folder.",
      };
    }
    if (groupId !== null) return { url: assignmentUrl(baseUrl, courseId, folder.Id, groupId), urlKind: "assignment" };
    return {
      url: courseHome,
      urlKind: "course-home",
      urlNote: "Brightspace did not identify a unique group for this assignment. Open Assignments from the course home to select the folder.",
    };
  };
}

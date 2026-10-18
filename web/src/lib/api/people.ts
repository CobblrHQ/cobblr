import { request } from "./client";
import type { WorkspaceInvite } from "./members";

/** Someone on the workspace's People list (#3787). */
export interface WorkspacePerson {
  id: string;
  name: string;
  user_id: string | null;
  email: string | null;
  /** A number to text, in international form. */
  phone: string | null;
  member: boolean;
  left: boolean;
}

export const peopleApi = {
  /** The workspace's People list: members and anyone added by name (#3787). */
  listPeople: (slug: string) => request<{ items: WorkspacePerson[] }>("GET", `/orgs/${slug}/people`),
  addPerson: (slug: string, body: { name: string; email?: string; phone?: string }) =>
    request<WorkspacePerson>("POST", `/orgs/${slug}/people`, body),
  updatePerson: (slug: string, id: string, body: { name?: string; email?: string; phone?: string }) =>
    request<WorkspacePerson>("PATCH", `/orgs/${slug}/people/${id}`, body),
  /** Everything one person owns, across every collection: `who` is an id, a
   *  name, or "me" (My things). */
  personThings: (slug: string, who: string) =>
    request<{
      person: WorkspacePerson;
      count: number;
      groups: Array<{ kind: string; label: string; field: string; field_label: string; items: Array<{ id: string; title: string; path: string | null }> }>;
    }>("GET", `/orgs/${slug}/people/things?person=${encodeURIComponent(who)}`),
  /** Hand everything one person owns to someone else on the list. */
  handOffPerson: (slug: string, id: string, to: string) =>
    request<{ moved: number; kept: Array<{ kind: string; id: string; title: string }> }>("POST", `/orgs/${slug}/people/${id}/hand-off`, { to }),
  /** Invite someone on the list to become a member; accepting keeps what is theirs. */
  invitePerson: (slug: string, id: string, body: { email?: string }) =>
    request<WorkspaceInvite & { emailed: boolean }>("POST", `/orgs/${slug}/people/${id}/invite`, body),
};

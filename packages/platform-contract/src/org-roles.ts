// Who is allowed to do a thing, decided once.
//
// THE BUG THIS EXISTS FOR. The kernel's `requireRole` has always been
// rank-based, and says so: a more-privileged role satisfies any check a lesser
// one passes. Every module then grew its own copy in `src/api/util.ts`, and all
// 34 of them wrote it as an exact-set membership test:
//
//     if (!allowed.includes(ctx.role)) → 403
//
// Which means a call site reading `requireRole(req, res, "owner", "admin",
// "member")` — the ordinary "anyone who can write" gate — REJECTED an editor,
// because "editor" is not literally in that list. An editor could read the
// whole workspace and write nothing in it: no records, no purchases, no views,
// no comments. The 403 even said "requires one of: owner, admin, member", which
// reads like the role does not exist rather than like a bug.
//
// It survived because nothing exercised it. Every test and every demo runs as
// the workspace owner, and an owner satisfies both implementations.
//
// So the ranking lives HERE, in the contract both halves already import, rather
// than being written a 35th time. Same reasoning as entity-tokens: a rule two
// sides can disagree about will eventually be a rule two sides disagree about.

/**
 * THE role vocabulary. Every list of roles anywhere derives from this one.
 *
 * Ordered most privileged first, because that is the order a person reads them
 * in and the order the UI offers them.
 *
 * Before this existed the vocabulary was hand-written in 49 places, and 47 of
 * them had fallen behind: module `db.ts` files typed the role as
 * `"owner" | "admin" | "member" | "guest"`, three zod enums REJECTED "editor"
 * outright (so a cross-workspace link could not be restricted to editors, and a
 * super-admin could not create one), and the user manual listed four roles while
 * the app offered five. Adding a role meant finding all 49; nobody did, twice.
 */
export const ORG_ROLES = ["owner", "admin", "editor", "member", "guest"] as const;

/** The roles a person can hold in a workspace. Derived, never retyped. */
export type OrgRoleName = (typeof ORG_ROLES)[number];

/**
 * The roles you can invite somebody AS.
 *
 * Owner is missing on purpose: ownership is transferred to an existing member,
 * not handed to a stranger through a link.
 */
export const INVITABLE_ORG_ROLES = ["admin", "editor", "member", "guest"] as const;
export type InvitableOrgRole = (typeof INVITABLE_ORG_ROLES)[number];

/**
 * One line each, in the product's own words.
 *
 * Lives here so the members modal, the invite picker and the manual cannot
 * describe the same role three different ways — which is the drift this file
 * exists to end, one level up from the names themselves.
 */
export const ORG_ROLE_BLURB: Record<OrgRoleName, string> = {
  owner: "Runs the workspace. Can change any role, remove anyone, and delete the workspace.",
  admin: "Manages people and settings. Can change non-owner roles and mint invites.",
  editor:
    "Trusted with the contents, not the membership. Builds, configures and edits everything, but cannot manage who is in the workspace.",
  member: "Does the day-to-day work. Full access to the data, no say over people or settings.",
  guest: "Along for the ride. Reads what the workspace shares.",
};

/**
 * Action-gating rank. A more-privileged role satisfies any check a lesser one
 * passes, and every call site is hierarchical — they all start at "owner".
 *
 * `editor` sits at admin-tier FOR ACTIONS deliberately: it does the full
 * builder, config and data work. The two genuine governance gates are not
 * rank-based at all — managing members is owner/admin only, and deleting a
 * workspace is owner-only — so an editor is admin minus {manage members,
 * delete workspace}. Do not "fix" the tie; it is the design.
 */
export const ORG_ROLE_RANK: Record<OrgRoleName, number> = {
  guest: 0,
  member: 1,
  editor: 2,
  admin: 2,
  owner: 3,
};

/**
 * Does `role` satisfy a gate that lists `allowed`?
 *
 * The list is read as its WEAKEST entry: `("owner", "admin", "member")` means
 * "member or better", which is what every call site meant when it wrote the
 * roles out longhand. An unknown role never passes, and an empty list never
 * passes, so a typo fails closed.
 */
export function roleSatisfies(role: string | null | undefined, allowed: readonly string[]): boolean {
  if (!role || allowed.length === 0) return false;
  const have = ORG_ROLE_RANK[role as OrgRoleName];
  if (have === undefined) return false;
  const need = Math.min(
    ...allowed.map((r) => ORG_ROLE_RANK[r as OrgRoleName] ?? Number.POSITIVE_INFINITY),
  );
  return have >= need;
}

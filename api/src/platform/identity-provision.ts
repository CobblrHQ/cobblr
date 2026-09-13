// What a central-identity sign-in does to the local account: the decision,
// with no database in it, so it can be pinned by a test.
//
// Identity is the fourth way an account gets made here. The other three (the
// signup form, POST /orgs, POST /provision-app) agree that a managed-app
// signup provisions the workspace AS the app (bundle + app mode). Identity did
// not: a person who pressed "Continue with your Cobblr account" on
// /start/yarn got "<name>'s workspace" with the platform chrome that page
// exists to hide. So the hand-off carries the app, and a NEW account is
// provisioned as it.
//
// An unknown app is ignored, never an error: the sign-in is the thing that
// must not fail, and a stale link to an app that no longer exists should
// still get the person a workspace. An EXISTING account is adopted and left
// as it is; offering it the app is a follow-up.

export type IdentityWorkspacePlan =
  | { kind: "adopt" }
  | { kind: "provision"; app: string | null };

export function planIdentityWorkspace(input: {
  existing: boolean;
  app: string | undefined | null;
  isKnownApp: (id: string) => boolean;
}): IdentityWorkspacePlan {
  if (input.existing) return { kind: "adopt" };
  const app = (input.app ?? "").trim();
  return { kind: "provision", app: app && input.isKnownApp(app) ? app : null };
}

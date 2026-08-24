// Provision a managed vertical app ("Cobblr for Yarn") in one step: create the
// workspace, apply the app's flagship bundle, and flip it into app mode — so a
// consumer signup lands in a working, locked-down app. Composes the existing
// pieces (provisionOrgForUser + validateBundle/applyValidatedBundle + the
// managed-app registry + the app_mode flag). See
// business-models/docs/18-managed-vertical-apps.md.

import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { validateBundle, applyValidatedBundle, cmpVersion } from "../routes/bundles.js";
import { getOfficialBundleManifest } from "../routes/registry.js";
import { getManagedApp, type ManagedApp } from "./managed-apps.js";
import { listInstances } from "./instances.js";
import { upsertOverride } from "./entity-kind-overrides.js";

/** Write the app's curated `nav_order` onto each nav entry's override, so the
 *  navbar reads left-to-right in the intended order (Yarn, Hooks, Designs, …)
 *  instead of alphabetically. Idempotent — safe to re-run on every app entry
 *  (that's how an EXISTING workspace backfills). A nav entry is either a named
 *  instance (target `instance:<module>:<instance_name>`) or a module's default
 *  entry (target `instance:<module>:<module>`); `instance_name` is workspace-
 *  unique, so the instance map disambiguates. Best-effort: a failure here must
 *  never break provisioning / refresh. */
async function applyManagedAppNavOrder(orgId: string, app: ManagedApp): Promise<void> {
  if (!app.navOrder?.length) return;
  try {
    const insts = await listInstances(orgId);
    const moduleByInstanceName = new Map(
      insts.filter((i) => !i.is_default).map((i) => [i.instance_name, i.module_name]),
    );
    for (let i = 0; i < app.navOrder.length; i++) {
      const entry = app.navOrder[i]!;
      // Named instance → its module; otherwise the entry IS a module name and
      // we target its default instance (`<module>:<module>`).
      const moduleName = moduleByInstanceName.get(entry) ?? entry;
      await upsertOverride({
        orgId,
        targetKind: "instance",
        targetId: `${moduleName}:${entry}`,
        navOrder: i,
      });
    }
  } catch (err) {
    console.error(`[applyManagedAppNavOrder] ${orgId} failed:`, (err as Error).message);
  }
}

export interface ProvisionAppResult {
  orgId: string;
  slug: string;
  app: { app: string; home_path: string; label: string };
}

/** Create a managed-app workspace for a user. The bundle manifest is resolved
 *  server-side: an explicit `manifest` (tests / operator) wins, else the rich
 *  published version is fetched from the official registry by `app.bundleId` —
 *  so a normal consumer signup needn't (and shouldn't) ship the manifest.
 *  Throws on an unknown app id, an unresolvable bundle, or an invalid one. */
export async function provisionAppWorkspace(
  userId: string,
  appId: string,
  manifest: unknown | undefined,
  sess: { display_name?: string | null; auth_method: "session" | "api_token" | "system"; api_token_id?: string | null } = { auth_method: "session" },
): Promise<ProvisionAppResult> {
  const app = getManagedApp(appId);
  if (!app) throw new ProvisionAppError("unknown_app", `Unknown managed app "${appId}".`);

  // The server owns the bundle: prefer the published registry manifest; an
  // explicit manifest (tests / operator override) takes precedence when given.
  const resolved = manifest ?? (await getOfficialBundleManifest(app.bundleId));
  if (!resolved) {
    throw new ProvisionAppError("bundle_unavailable", `Couldn't load the "${app.id}" app bundle right now. Try again shortly.`);
  }

  // 1. The workspace (tenant DB, default modules, owner membership). Dynamic
  //    import: auth.ts also imports this module (for the signup-app branch), so
  //    a static import here would be a load-time cycle — the call is at runtime.
  const { provisionOrgForUser } = await import("../routes/auth.js");
  const { orgId, slug } = await provisionOrgForUser(userId, app.label);

  // 2. Apply the flagship bundle (autoEnable: the app's required modules get
  //    enabled as part of the install, no separate confirm step). The app's
  //    curated optional features ride in too — a locked app can't enable them
  //    later, so they're on from the start (scan, hooks, … for yarn).
  const v = await validateBundle(orgId, resolved, { autoEnable: true, enabledFeatures: app.enabledFeatures });
  if (!v.valid) {
    throw new ProvisionAppError("invalid_bundle", "The app's bundle failed validation.", { errors: v.errors });
  }
  await applyValidatedBundle(orgId, { id: userId, display_name: sess.display_name ?? null, auth_method: sess.auth_method, api_token_id: sess.api_token_id ?? null }, v);

  // 2b. Curate the nav order (Yarn, Hooks, Designs, …) — the bundle creates the
  //     instances/overrides above; this stamps each one's nav_order.
  await applyManagedAppNavOrder(orgId, app);

  // 3. Flip the workspace into the managed app (the web then hides the platform
  //    and lands the user in app.homePath).
  const appMode = { app: app.id, home_path: app.homePath, label: app.label };
  await meta
    .updateTable("orgs")
    .set({ app_mode: sql`${JSON.stringify(appMode)}::jsonb` as never, updated_at: new Date() })
    .where("id", "=", orgId)
    .execute();

  return { orgId, slug, app: appMode };
}

/** Auto-update: re-apply the latest published version of a managed app's bundle
 *  to a workspace when it's behind. Idempotent + user-data-preserving (that's
 *  `applyValidatedBundle`), so a no-op when already current. Called lazily when
 *  a managed-app user enters the app ("refresh on use") — the managed promise of
 *  "updates flow automatically" without the user managing anything. `manifest`
 *  is a test/operator override; production resolves it from the registry.
 *  Returns `{updated:false}` (never throws) on any soft failure so a transient
 *  registry hiccup never breaks someone's app. */
export async function refreshManagedApp(
  orgId: string,
  userId: string | null,
  manifestOverride?: unknown,
): Promise<{ updated: boolean; from?: string; to?: string }> {
  try {
    const org = await meta.selectFrom("orgs").select("app_mode").where("id", "=", orgId).executeTakeFirst();
    const appMode = org?.app_mode as { app: string } | null;
    if (!appMode) return { updated: false };
    const app = getManagedApp(appMode.app);
    if (!app) return { updated: false };

    // Always (re)assert the curated nav order — cheap, idempotent, and the path
    // by which an EXISTING app backfills it (the web calls refresh-app once per
    // session on entry). Runs before the version/feature early-return below.
    await applyManagedAppNavOrder(orgId, app);

    const manifest = manifestOverride ?? (await getOfficialBundleManifest(app.bundleId));
    if (!manifest) return { updated: false }; // registry unreachable — leave the app as-is
    const latest = (manifest as { version?: string }).version;

    const installed = await meta
      .selectFrom("bundles")
      .select(["version", "enabled_features"])
      .where("org_id", "=", orgId)
      .where("external_id", "=", app.bundleId)
      .executeTakeFirst();
    // Re-apply when the workspace is BEHIND the published version, OR when the
    // app now curates a feature the workspace doesn't have yet (a locked app
    // can't enable features itself, so rolling out a new app feature happens
    // here on next use). Already current AND feature-complete → nothing to do.
    // Only features THIS manifest declares can be missing - a curated key the
    // bundle does not have is nothing to install, and treating it as missing
    // makes every refresh re-apply, forever, on a workspace that is already
    // current. (Latent until the stored set stopped keeping phantom keys: it
    // used to record whatever was requested, declared or not.)
    const declared = new Set(
      ((manifest as { features?: Array<{ key?: string }> }).features ?? [])
        .map((f) => f.key)
        .filter((k): k is string => typeof k === "string"),
    );
    const want = (app.enabledFeatures ?? []).filter((f) => declared.has(f));
    const have = new Set((installed?.enabled_features as string[] | null) ?? []);
    const featuresMissing = want.some((f) => !have.has(f));
    const versionCurrent = installed && latest && cmpVersion(installed.version, latest) >= 0;
    if (versionCurrent && !featuresMissing) return { updated: false };

    const v = await validateBundle(orgId, manifest, { autoEnable: true, enabledFeatures: app.enabledFeatures });
    if (!v.valid) return { updated: false }; // never apply a bad manifest over a working app
    await applyValidatedBundle(orgId, { id: userId ?? "", auth_method: "system" }, v);
    return { updated: true, from: installed?.version, to: latest };
  } catch (err) {
    console.error(`[refreshManagedApp] ${orgId} failed:`, (err as Error).message);
    return { updated: false };
  }
}

/** Graduation import: copy a managed app's data into a FULL workspace (the
 *  "start a business workspace + bring my yarn over" path — business-models/docs/18).
 *  It (1) ensures the target has the app's bundle (so the matching instance +
 *  its fields exist), then (2) copies the source instance's items — name, qty,
 *  unit, and every custom field — into the target instance. Cross-tenant, but
 *  ONLY through the platform seam (entities.list to read, inventory:create-item
 *  to write) — never a join. Source data is left untouched (a copy, not a move).
 *  Photos are NOT yet copied (a follow-up). Caller must own/admin both workspaces. */
export async function importAppData(
  sourceOrgId: string,
  targetOrgId: string,
  userId: string,
): Promise<{ imported: number; instance: string }> {
  const src = await meta.selectFrom("orgs").select("app_mode").where("id", "=", sourceOrgId).executeTakeFirst();
  const appMode = src?.app_mode as { app: string } | null;
  if (!appMode) throw new ProvisionAppError("not_an_app", "The source workspace isn't a managed app.");
  const app = getManagedApp(appMode.app);
  if (!app) throw new ProvisionAppError("unknown_app", `Unknown managed app "${appMode.app}".`);

  // 1. Ensure the target has the app's bundle (idempotent) → its instance +
  //    custom fields exist there, so the copied rows have a home + render right.
  //    Use the SOURCE's installed manifest (stored on its bundles row) so the
  //    target matches the app exactly — no registry round-trip, no version skew.
  const srcBundle = await meta
    .selectFrom("bundles")
    .select(["manifest", "enabled_features"])
    .where("org_id", "=", sourceOrgId)
    .where("external_id", "=", app.bundleId)
    .executeTakeFirst();
  if (!srcBundle?.manifest) throw new ProvisionAppError("source_bundle_missing", "The source app's bundle isn't installed.");
  // Mirror the source app's feature set (stored manifest is the FULL manifest, so
  // resolve it against the same features) — the graduated workspace gets the same
  // Hooks/Designs/scan the app had. There the user CAN tweak them (it's unlocked).
  const v = await validateBundle(targetOrgId, srcBundle.manifest, {
    autoEnable: true,
    enabledFeatures: (srcBundle.enabled_features as string[] | null) ?? app.enabledFeatures,
  });
  if (!v.valid) throw new ProvisionAppError("invalid_bundle", "The app's bundle failed validation.", { errors: v.errors });
  await applyValidatedBundle(targetOrgId, { id: userId, auth_method: "session" }, v);

  // The target's slug — internal photo URLs are slug-scoped, so a copied photo
  // gets a fresh URL pointing at the NEW workspace.
  const targetSlug = (await meta.selectFrom("orgs").select("slug").where("id", "=", targetOrgId).executeTakeFirst())?.slug;
  // Copy a source photo into the target workspace's file store and return its new
  // (target-scoped) URL. An internal core-files photo is duplicated byte-for-byte
  // (read from source → write to target → new URL) so it survives even if the app
  // is later deleted; an EXTERNAL url (a catalog image) is portable, so pass it
  // through. Returns null ONLY when the source item genuinely has no photo.
  //
  // A source item that DOES carry an internal photo MUST arrive with it: a
  // read/write failure THROWS rather than silently landing the item photoless.
  // Swallowing it (the old `return null`) made graduation best-effort — under
  // 8-fork CI contention a transient IO hiccup was absorbed, the item copied
  // without its picture, `import-app` still 200'd, and the read-back saw
  // `image_path === undefined` (the graduation-photos flake). Failing loud makes
  // the flow ATOMIC: a 2xx response now guarantees every copied item's photo
  // path is durably set before the flow reports done.
  const FILE_URL_RE = /\/orgs\/[^/]+\/modules\/core-files\/files\/([^/?]+)\/raw/;
  async function copyPhoto(src: unknown): Promise<string | null> {
    if (typeof src !== "string" || !src) return null; // genuinely photoless
    const fileId = src.match(FILE_URL_RE)?.[1];
    if (!fileId) return src; // external (catalog) URL — portable, copy the string as-is
    if (!targetSlug) throw new ProvisionAppError("target_slug_missing", "The target workspace has no slug — cannot scope the copied photo URL.");
    const bytes = await platform().files.read(sourceOrgId, fileId, "original");
    if (!bytes) throw new ProvisionAppError("photo_copy_failed", `Could not read source photo ${fileId} to copy into the graduated workspace.`);
    const w = await platform().files.write(targetOrgId, bytes.bytes, { filename: bytes.filename, mimeType: bytes.mimeType });
    if (!w) throw new ProvisionAppError("photo_copy_failed", "Could not write the copied photo into the graduated workspace.");
    return `/api/v1/orgs/${targetSlug}/modules/core-files/files/${w.fileId}/raw`;
  }

  // 2. Copy the source instance's items into the target instance.
  const kind = `${app.instanceName}:item`;
  const { items } = await platform().entities.list(sourceOrgId, kind, { limit: 1000 });
  let imported = 0;
  for (const it of items) {
    const f = (it.fields ?? {}) as Record<string, unknown>;
    const customFields = f.metadata && typeof f.metadata === "object" ? (f.metadata as Record<string, unknown>) : {};
    const image_path = await copyPhoto((it as { image_path?: unknown }).image_path ?? f.image_path);
    // Awaited AND unguarded: a failed create must fail the whole import, not be
    // silently swallowed (the old `.catch()` counted the item as imported while
    // it never landed — a graduated workspace missing a row, and the second half
    // of the graduation-photos flake). Atomic: the import 2xx's only when every
    // item is actually created.
    await platform().actions.invoke("inventory:create-item", {
      orgId: targetOrgId,
      userId,
      entity: { kind, id: "" },
      event: { name: "sales.import", payload: {}, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" },
      args: {
        instance: app.instanceName,
        name: it.title ?? (typeof f.name === "string" ? f.name : "Untitled"),
        qty: typeof f.qty === "number" ? f.qty : Number(f.qty) || 1,
        unit: typeof f.unit === "string" ? f.unit : undefined,
        manufacturer: typeof f.manufacturer === "string" ? f.manufacturer : undefined,
        image_path: image_path ?? undefined,
        fields: customFields,
      },
      entityKind: kind,
      entityId: "",
    });
    imported++;
  }
  return { imported, instance: app.instanceName };
}

export class ProvisionAppError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

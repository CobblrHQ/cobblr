// The platform contract — types and validators that modules import
// when registering with cobblr-core. Modules MUST NOT import from
// @cobblr/api directly; everything they need crosses through here.
//
// Phase 0 ships the stub: the typed manifest schema, defineModule(),
// and intent declaration shape. Module loading wires onto these in
// later phases.

import { z } from "zod";

// ───────────────────────── Module manifest ─────────────────────────

const Intent = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Zod's runtime type for the payload schema. Modules pass a real
  // ZodSchema; we type it loosely here to avoid coupling to a specific
  // version of zod in the validator output.
  schema: z.unknown().optional(),
});

const NavItem = z.object({
  label: z.string().min(1),
  route: z.string().regex(/^\//, "route must start with /"),
  icon: z.string().optional(),
});

const ModuleManifest = z.object({
  // Stable identifier — must be unique across the platform, used as
  // the table prefix and the URL segment under /api/v1/modules/.
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, "name must be kebab/snake-case ascii"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver-ish"),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),

  schema: z.object({
    tablePrefix: z.string().regex(/^[a-z][a-z0-9_]*_$/, "tablePrefix must end with _"),
    migrationsDir: z.string().min(1),
  }),

  // The api/ui imports are functions returning a dynamic import so
  // the loader can decide when to evaluate them (and so modules can
  // be lazily code-split in the web bundle).
  api: z.function().returns(z.promise(z.unknown())).optional(),
  ui: z
    .object({
      navItems: z.array(NavItem).default([]),
      components: z.function().returns(z.promise(z.unknown())).optional(),
    })
    .optional(),

  intents: z.array(Intent).default([]),
  dependencies: z.array(z.string()).default([]),
  exposes: z
    .object({
      events: z.array(z.string()).default([]),
      api: z.array(z.string()).default([]),
    })
    .default({ events: [], api: [] }),
  subscribes: z.array(z.string()).default([]),
});

export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModuleIntent = z.infer<typeof Intent>;

/**
 * Builder for a module's default export. Validates the manifest at
 * load time — invalid shape throws with a readable message before
 * the module is registered. Returns the validated manifest, typed.
 *
 * Usage in a module:
 *   export default defineModule({ name: "inventory", ... });
 */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  const result = ModuleManifest.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid module manifest for "${
        (manifest as { name?: unknown }).name ?? "<unnamed>"
      }":\n${issues}`,
    );
  }
  return result.data;
}

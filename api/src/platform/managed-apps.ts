// Managed vertical apps ("Cobblr for Yarn"). The server-side registry of which
// single-purpose apps a workspace can be locked into. Each app maps to a flagship
// bundle + where to land + a display label. Setting a workspace's `app_mode` to
// one of these flips it into the managed, chrome-free experience (the web reads
// `org.app_mode` and hides the platform). See
// business-models/docs/18-managed-vertical-apps.md.

export interface ManagedApp {
  /** Stable app id, stored on org.app_mode.app. */
  id: string;
  /** Display label shown in place of the workspace name. */
  label: string;
  /** The flagship bundle that defines the app's fields/views/wires. */
  bundleId: string;
  /** Route the user lands in inside the app (a module/instance route). */
  homePath: string;
  /** The inventory instance the app's data lives in (its `<instanceName>:item`
   *  kind). Used by the graduation import to copy the user's data into a full
   *  workspace's matching instance. */
  instanceName: string;
  /** The bundle's optional FEATURES the managed app ships with ON. A managed app
   *  is LOCKED — there's no Configuration page, so the consumer can never enable
   *  a feature themselves; whatever the funnel provisions with is what they get.
   *  So the app curates them here (the bundle's feature keys), and provisioning +
   *  auto-update both apply them. Omit / empty → only the bundle's `default:true`
   *  features (none, for yarn). */
  enabledFeatures?: string[];
}

export const MANAGED_APPS: Record<string, ManagedApp> = {
  yarn: {
    id: "yarn",
    label: "Cobblr for Yarn",
    bundleId: "cobblr.flagship.yarn",
    // The Yarn bundle provides an inventory instance named "yarn" → its table
    // lives at /instances/yarn. That's where the user lands.
    homePath: "/instances/yarn",
    instanceName: "yarn",
    // The full Cobblr-for-Yarn experience: scan a ball-band to add (the headline),
    // a Hooks table, auto-restock shopping list, and a Designs/patterns table.
    // All four are `default:false` on the bundle — a locked consumer can't turn
    // them on later, so the managed app ships them ON.
    enabledFeatures: ["scan", "hooks", "shopping-list", "designs"],
  },
};

export function getManagedApp(id: string): ManagedApp | null {
  return MANAGED_APPS[id] ?? null;
}

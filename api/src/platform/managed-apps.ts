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
  /** Left-to-right nav order, by nav-entry name: a named instance's
   *  `instance_name` (yarn, hooks, designs) or a module name for its default
   *  entry (lists, purchases). Provisioning writes each as `nav_order` on the
   *  matching entity-kind override; entries omitted here (e.g. Scan) sort after,
   *  alphabetically. Without this the nav is alphabetical (Designs before Yarn). */
  navOrder?: string[];
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
    // Only the instance tops need explicit ordering (Yarn the headline, then the
    // secondary trackers). Everything WITHOUT a nav_order sorts after these,
    // alphabetically — and lists < purchases < scan already gives the intended
    // tail (Lists, Purchases, Scan). Naming only instances also keeps this kernel
    // file from hardcoding module names (the isolation lint).
    navOrder: ["yarn", "hooks", "designs"],
  },
  home: {
    id: "home",
    label: "Cobblr for Home",
    bundleId: "cobblr.flagship.home-inventory",
    // The catalog is the home; the CAMERA is the first screen on a phone (the
    // web's StartAppPage sends a touch device straight to /scan/camera after
    // signup, and the table's empty state points there). A desktop signup lands
    // here and pairs a phone from it.
    homePath: "/instances/home-inventory",
    instanceName: "home-inventory",
    // The whole point of the app: scan a thing, it files into a room, a label
    // prints. All three are bundle features a locked consumer could never turn
    // on later, so the app ships them ON. Insurance stays off (a checkbox on the
    // full platform, noise on a first day).
    enabledFeatures: ["scan", "print-labels", "rooms"],
    navOrder: ["home-inventory"],
  },
  groceries: {
    id: "groceries",
    label: "Cobblr for Groceries",
    bundleId: "cobblr.flagship.groceries",
    // The board ("What's on hand", the bundle's pinned vending view) is the
    // app: the instance page opens on its pinned board when asked to, and the
    // receipt door is one tap away in the scan inbox.
    homePath: "/instances/groceries?view=board",
    instanceName: "groceries",
    // Kitchen, with Fridge / Freezer / Pantry inside it, so a receipt's lines
    // have somewhere to go on day one.
    enabledFeatures: ["kitchen-places"],
    navOrder: ["groceries"],
  },
};

export function getManagedApp(id: string): ManagedApp | null {
  return MANAGED_APPS[id] ?? null;
}

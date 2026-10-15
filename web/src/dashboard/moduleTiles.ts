// The dashboard tiles a module draws, as their own small chunks (#6563). A
// module's tile registered itself only when the module's whole page code
// happened to load, so on a quiet visit inventory's tile arrived seconds after
// the rest and pushed the page down. The dashboard loads these before it is
// shown (snapshot.tsx), and each registers itself as it always did.
const TILES: Record<string, () => Promise<unknown>> = {
  inventory: () => import("@cobblr/inventory/ui/dashboard-widget"),
  labels: () => import("@cobblr/labels/ui/dashboard-widget"),
  projects: () => import("@cobblr/projects/ui/dashboard-widget"),
};

export function loadModuleTiles(): Promise<unknown> {
  return Promise.all(Object.values(TILES).map((load) => load()));
}

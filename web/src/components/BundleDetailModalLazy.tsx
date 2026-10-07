// The bundle detail dialog, loaded when it opens. It carries the featured
// bundles' manifests (about 50 KB gzipped), so the pages that can open it
// (the dashboard's what-to-do panel among them) would otherwise carry them on
// every first load (#4945).
import type { ComponentProps, ComponentType } from "react";
import { lazyOverlay } from "@cobblr/platform-web";
import type { BundleDetailModal as Dialog } from "./BundleDetailModal";

export const BundleDetailModal: ComponentType<ComponentProps<typeof Dialog>> & { preload: () => void } = lazyOverlay(() =>
  import("./BundleDetailModal").then((m) => ({ default: m.BundleDetailModal })),
);

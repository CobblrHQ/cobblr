// Resolve a module's kebab-case icon name (from its manifest) to a
// lucide component. Curated map rather than a dynamic `import * as
// lucide` so the bundle stays tree-shaken — extend as modules declare
// new header-action icons. Unknown names fall back to a generic glyph
// so something always renders.

import {
  Album,
  Boxes,
  Camera,
  Layers,
  ListChecks,
  ScanBarcode,
  ScanLine,
  ShoppingCart,
  Sparkles,
  Tag,
  Wand2,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  album: Album,
  "scan-line": ScanLine,
  camera: Camera,
  "scan-barcode": ScanBarcode,
  boxes: Boxes,
  wrench: Wrench,
  layers: Layers,
  "shopping-cart": ShoppingCart,
  tag: Tag,
  "list-checks": ListChecks,
  sparkles: Sparkles,
  "wand-2": Wand2,
};

export function moduleIcon(name: string | null | undefined): LucideIcon {
  return (name && MAP[name]) || Zap;
}

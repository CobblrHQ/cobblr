// Icon name → lucide component for hosted settings panels and live controls.
// The overlay sends a generic icon NAME (e.g. "credit-card"); the names come
// from the one map in module-icon.ts. Unknown names fall back to Plug, which is
// for a name we have genuinely not seen, never one we ship (lint:live-icons).

import { Plug, type LucideIcon } from "lucide-react";
import { ICON_NAMES } from "./module-icon";

export function iconForName(name?: string): LucideIcon {
  return (name && ICON_NAMES[name]) || Plug;
}

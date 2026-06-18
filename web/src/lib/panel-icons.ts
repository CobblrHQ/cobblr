// Generic icon-name → lucide component map for hosted settings panels. The
// overlay sends a generic icon NAME (e.g. "credit-card"); the web maps a small
// allowlist. Unknown names fall back to Plug. Keeping this generic means no
// panel-specific (proprietary) wiring lives in the open-core web app.

import { CreditCard, MessageSquare, Plug, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "credit-card": CreditCard,
  "message-square": MessageSquare,
  plug: Plug,
};

export function iconForName(name?: string): LucideIcon {
  return (name && ICONS[name]) || Plug;
}

// Generic icon-name → lucide component map for hosted settings panels. The
// overlay sends a generic icon NAME (e.g. "credit-card"); the web maps a small
// allowlist. Unknown names fall back to Plug. Keeping this generic means no
// panel-specific (proprietary) wiring lives in the open-core web app.

import { Bot, Box, CreditCard, Hammer, History, MessageSquare, Package, Plug, Printer, ScanLine, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "credit-card": CreditCard,
  "message-square": MessageSquare,
  plug: Plug,
  // Live-box control icons. These were all missing, so every ring in the Live
  // box rendered the Plug fallback — auto-print and scan-drive included, which
  // is every control that ships today. The fallback is meant for an icon we do
  // not recognise, not for the ones we ship.
  printer: Printer,
  "scan-line": ScanLine,
  bot: Bot,
  hammer: Hammer,
  history: History,
  package: Package,
  box: Box,
};

export function iconForName(name?: string): LucideIcon {
  return (name && ICONS[name]) || Plug;
}

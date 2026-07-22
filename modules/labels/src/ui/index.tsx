// Labels module UI export. The host mounts <LabelsUI /> inside its
// router; the host should also mount <LabelsBasket /> at the app
// root so the queue badge shows up across every page.
//
// Other modules can import { useLabels, LabelsApi } from
// '@cobblr/labels/ui' to call the labels API directly when adding
// items to the queue from their own UI.

import { Routes, Route } from "react-router-dom";
import { Tag } from "lucide-react";
// Side-effect: registers the labels "at a glance" dashboard tile through
// platform-web's registerDashboardWidget seam when this UI bundle loads.
import "./DashboardWidget";
import { LabelsProvider, useLabels } from "./context";
import { QueuePage } from "./QueuePage";
import { BasketWidget } from "./BasketWidget";
import { ClientAutoflushMount } from "./client-autoflush";

export const navItems = [
  { label: "Labels", path: "/labels", icon: Tag },
];

interface LabelsUIProps {
  orgSlug: string;
  getToken: () => string | null;
}

export function LabelsUI({ orgSlug, getToken }: LabelsUIProps) {
  return (
    <LabelsProvider orgSlug={orgSlug} getToken={getToken}>
      <Routes>
        <Route index element={<QueuePage />} />
      </Routes>
    </LabelsProvider>
  );
}

/** App-root / sidebar-foot / mobile-menu mount: the queue widget, wrapped in its
 *  provider. `asRow` picks the nav-style row over the floating pill (the host
 *  chooses per shell mode — see BasketWidget); `rowClassName` + `onNavigate` let
 *  the host style the row to its own menu and close it on tap. Renders nothing
 *  when the queue is empty. */
export function LabelsBasket({
  orgSlug,
  getToken,
  asRow,
  rowClassName,
  onNavigate,
}: LabelsUIProps & { asRow?: boolean; rowClassName?: string; onNavigate?: () => void }) {
  return (
    <LabelsProvider orgSlug={orgSlug} getToken={getToken}>
      {/* The client-fired (Bluetooth) auto-print loop. Headless + a module-scope
          singleton, so mounting it in every LabelsBasket is safe. */}
      <ClientAutoflushMount />
      <BasketWidget asRow={asRow} rowClassName={rowClassName} onNavigate={onNavigate} />
    </LabelsProvider>
  );
}

export { useLabels, LabelsProvider };
export { LabelsApi } from "./api";
export type { QueueItem, Printable, PrintResponse } from "./api";
export default LabelsUI;

// Labels module UI export. The host mounts <LabelsUI /> inside its
// router; the host should also mount <LabelsBasket /> at the app
// root so the queue badge shows up across every page.
//
// Other modules can import { useLabels, LabelsApi } from
// '@cobblr/labels/ui' to call the labels API directly when adding
// items to the queue from their own UI.

import { Routes, Route } from "react-router-dom";
import { Tag } from "lucide-react";
import { LabelsProvider, useLabels } from "./context";
import { QueuePage } from "./QueuePage";
import { BasketWidget } from "./BasketWidget";

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

/** App-root mount: shows the floating basket on every page that's
 *  wrapped by LabelsProvider. */
export function LabelsBasket({ orgSlug, getToken }: LabelsUIProps) {
  return (
    <LabelsProvider orgSlug={orgSlug} getToken={getToken}>
      <BasketWidget />
    </LabelsProvider>
  );
}

export { useLabels, LabelsProvider };
export { LabelsApi } from "./api";
export type { QueueItem, Printable, PrintResponse } from "./api";
export default LabelsUI;

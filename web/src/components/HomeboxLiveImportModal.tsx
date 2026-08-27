// Homebox — the one-click LIVE import card. The flow lives in LiveImportModal;
// this is Homebox's descriptor: where the token comes from, what comes across,
// and the section order (locations first, so an item's location reference
// resolves through the id-map the first import populates).

import { LiveImportModal, type LiveImportSource } from "./LiveImportModal";

export const HOMEBOX_LIVE: LiveImportSource = {
  connectorId: "homebox",
  name: "Homebox",
  addressLabel: "Homebox address",
  addressPlaceholder: "http://homebox.local:3100",
  tokenPlaceholder: "Homebox → Profile → API tokens",
  intro: (
    <>
      In Homebox, open <strong>Profile → API tokens</strong> and create one. Paste your Homebox address and
      that token below. Items land in <strong>Inventory</strong>, the location tree rebuilds your{" "}
      <strong>Locations</strong>, and each item's <strong>photo</strong> comes across too. You choose whether
      to import once or keep it synced.
    </>
  ),
  sections: [
    { key: "locations", running: "your locations", stat: "locations" },
    { key: "items", running: "your items & photos", stat: "items imported" },
  ],
  photos: true,
  viewHref: "/inventory",
  viewLabel: "View Inventory",
};

export function HomeboxLiveImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <LiveImportModal source={HOMEBOX_LIVE} open={open} onClose={onClose} />;
}

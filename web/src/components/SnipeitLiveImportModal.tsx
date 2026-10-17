// Snipe-IT — the one-click LIVE import card. The flow lives in LiveImportModal;
// this is Snipe-IT's descriptor: where the token comes from, what comes across,
// and the section order (locations first, so an asset's location reference
// resolves through the id-map the first import populates).

import { LiveImportModal, type LiveImportSource } from "./LiveImportModal";

export const SNIPEIT_LIVE: LiveImportSource = {
  connectorId: "snipeit",
  name: "Snipe-IT",
  addressLabel: "Snipe-IT address",
  addressPlaceholder: "https://snipeit.example.com",
  tokenPlaceholder: "Snipe-IT → Account → Manage API keys",
  intro: (
    <>
      In Snipe-IT, open <strong>Account → Manage API keys</strong> and create a personal token. Paste your
      Snipe-IT address and that token below. Assets land in <strong>Assets</strong> with their serial number,
      asset tag, model, category, price and <strong>picture</strong>, and the location tree rebuilds your{" "}
      <strong>Locations</strong>. You choose whether to import once or keep it synced.
    </>
  ),
  sections: [
    { key: "locations", running: "your locations", stat: "locations" },
    { key: "hardware", running: "your assets & pictures", stat: "assets imported" },
  ],
  photos: true,
  viewHref: "/assets",
  viewLabel: "View Assets",
};

export function SnipeitLiveImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <LiveImportModal source={SNIPEIT_LIVE} open={open} onClose={onClose} />;
}

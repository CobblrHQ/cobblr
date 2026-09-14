// The scan inbox page's "more" menu: everything that is real but rare,
// grouped by what it acts ON, so "this inbox" and "elsewhere in the
// workspace" cannot be confused. The page keeps the state and the
// mutations; this file is the rows.
//
// On a HANDHELD it holds what a person at a shelf taps (the waiting filter,
// a receipt photo, things with no location, File everything). The rows that
// act on files, on many rows, or on settings are desk work and are not
// offered there: Live Sort (a bench rig with a wedge scanner and a spacebar;
// the phone's version is the camera's Sort mode), Fill missing photos,
// Export and Import, Drive this screen, the Auto-pick and First-look
// toggles, Same thing twice (docs/design-decisions/scan-inbox-device-split.md §3.1).
import { Copy, Download, Image as ImageIcon, LayoutGrid, MonitorSmartphone, MoreHorizontal, ReceiptText, Sparkles, Upload, Wand2, Zap } from "lucide-react";
import { HeaderMenu, MenuFilterLine, MenuHead, MenuItem, MenuSep } from "../components/HeaderMenu";
import { ReceiptAddressMenuBlock } from "../components/ReceiptAddressChip";
import { PairPhoneButton } from "../components/PairPhoneButton";

export interface ScanInboxMenuProps {
  handheld: boolean;
  triggerClassName: string;
  /** The waiting-2d+ filter, phone only (the desktop row carries the facet). */
  stale: { count: number; total: number; on: boolean; toggle: () => void };
  onLiveSort: () => void;
  onFillPhotos: () => void;
  onUploadReceipt: () => void;
  onExport: () => void;
  onImport: () => void;
  receiptAddress: string | null;
  onOrganizeUnplaced: () => void;
  scanDrive: { on: boolean; toggle: () => void };
  /** Owner/admin: the two capture toggles. `data` is undefined until loaded. */
  photoRank: { can: boolean; data?: { enabled: boolean }; pending: boolean; set: (enabled: boolean) => void };
  glance: { data?: { enabled: boolean }; pending: boolean; set: (enabled: boolean) => void };
  onFileEverything: () => void;
  onDuplicates: () => void;
  /** List or gallery. On a phone the switch lives here, since the row it
   *  sat on cost a line of the screen for two icons (#2982). */
  gallery: { on: boolean; toggle: () => void };
}

export function ScanInboxMenu(p: ScanInboxMenuProps) {
  const { handheld } = p;
  return (
    <HeaderMenu
      width={264}
      align="right"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} aria-label="More inbox actions" className={p.triggerClassName}>
          <MoreHorizontal size={15} />
        </button>
      )}
    >
      {({ close }) => (
        <>
          {/* A FILTER, not a setting: it wore a switch and read as something
              you were turning on. One quiet line at the very top, the size
              of a section title (reported 2026-08-10). Phone only - the
              desktop row still carries the facet itself. */}
          {p.stale.count > 0 && p.stale.count < p.stale.total && (
            <span className="sm:hidden">
              <MenuFilterLine
                active={p.stale.on}
                onClick={() => {
                  p.stale.toggle();
                  close();
                }}
              >
                {p.stale.on ? `Showing ${p.stale.count} waiting 2d+ · show all` : `${p.stale.count} waiting 2d+ · show only these`}
              </MenuFilterLine>
            </span>
          )}
          {!handheld && <MenuHead>Sort what&rsquo;s here</MenuHead>}
          {!handheld && (
            <MenuItem
              icon={<Zap size={14} className="text-amber-500" />}
              label="Live Sort"
              hint="Scan a thing, get told which bin it goes in, confirm, next"
              onClick={() => {
                close();
                p.onLiveSort();
              }}
            />
          )}
          <MenuSep />
          <MenuHead>This inbox</MenuHead>
          {!handheld && (
            <MenuItem
              icon={<ImageIcon size={14} />}
              label="Fill missing photos"
              hint="Find catalog photos for named items without one"
              onClick={() => {
                close();
                p.onFillPhotos();
              }}
            />
          )}
          {/* The one case the paperclip's type-routing cannot decide. A JPEG
              is a picture of a thing far more often than it is a receipt,
              so images go to the photo pipeline and that default is right -
              but a PHOTOGRAPH of a paper receipt is how most people capture
              one, and with no way to say so it came back named after
              whatever the vision pass read off it (reported 2026-08-19: a
              Walmart receipt landed as "Walmart 16in Cheese Pizza" and went
              looking for pizza pictures). The parser has always accepted
              images; only this door was missing. */}
          <MenuItem
            icon={<ReceiptText size={14} />}
            label="Upload a receipt photo"
            hint="A picture of a paper receipt, split into its line items"
            onClick={() => {
              close();
              p.onUploadReceipt();
            }}
          />
          {!handheld && (
            <MenuItem
              icon={<Download size={14} />}
              label="Export…"
              hint="Pick items and how photos travel"
              onClick={() => {
                close();
                p.onExport();
              }}
            />
          )}
          {/* Import belongs NEXT TO export, not with the uploads: it is the
              other half of the same conversation, and an export file is
              neither a pic nor a receipt. */}
          {!handheld && (
            <MenuItem
              icon={<Upload size={14} />}
              label="Import an export"
              hint="JSON or CSV, reversible in one click"
              onClick={() => {
                close();
                p.onImport();
              }}
            />
          )}
          {/* SHOW the address, don't just copy it invisibly. As a plain
              menu row this said "Email receipts to…" and put something on
              the clipboard you never saw - the desktop chip reveals the
              address, and the phone deserves the same fact (reported
              2026-08-10). */}
          {p.receiptAddress && (
            <span className="sm:hidden">
              <ReceiptAddressMenuBlock address={p.receiptAddress} onCopied={close} />
            </span>
          )}
          <MenuSep />
          <MenuHead>Elsewhere</MenuHead>
          <MenuItem
            icon={<Wand2 size={14} />}
            label="Things with no location"
            hint="Already filed - not in this inbox"
            onClick={() => {
              close();
              p.onOrganizeUnplaced();
            }}
          />
          {handheld && (
            <>
              <MenuSep />
              <MenuHead>Show as</MenuHead>
              <MenuItem
                icon={<LayoutGrid size={14} />}
                label="Gallery"
                hint="Big photo tiles instead of the list"
                state={p.gallery.on ? "on" : undefined}
                onClick={() => {
                  p.gallery.toggle();
                  close();
                }}
              />
            </>
          )}
          <MenuSep />
          <MenuHead>{handheld ? "Everything here" : "Capture setup"}</MenuHead>
          {!handheld && (
            <MenuItem
              icon={<MonitorSmartphone size={14} />}
              label="Drive this screen with scans"
              hint="Scan a bin's QR on your phone; this screen opens it"
              state={p.scanDrive.on ? "on" : "off"}
              onClick={() => {
                p.scanDrive.toggle();
                close();
              }}
            />
          )}
          {/* The two TOGGLES sit together; the one-shot action goes last.
              Interleaving them made a switch, a button and a switch read as
              three of the same kind (author, 2026-08-10). */}
          {!handheld && p.photoRank.can && p.photoRank.data && (
            <MenuItem
              icon={<Sparkles size={14} />}
              label="Auto-pick photos"
              hint="AI picks the catalog photo on every scan"
              state={p.photoRank.data.enabled ? "on" : "off"}
              disabled={p.photoRank.pending}
              onClick={() => p.photoRank.set(!p.photoRank.data!.enabled)}
            />
          )}
          {!handheld && p.photoRank.can && p.glance.data && (
            <MenuItem
              icon={<Sparkles size={14} />}
              label="First-look question"
              hint="a fast first read on every photo, asked as yes/no while the full read runs"
              state={p.glance.data.enabled ? "on" : "off"}
              disabled={p.glance.pending}
              onClick={() => p.glance.set(!p.glance.data!.enabled)}
            />
          )}
          <MenuItem
            icon={<Zap size={14} />}
            label="File everything"
            hint="a plan first: what gets added to things you have, what is filed as new, what is left for you"
            onClick={() => {
              p.onFileEverything();
              close();
            }}
          />
          {!handheld && (
            <MenuItem
              icon={<Copy size={14} />}
              label="Same thing twice"
              hint="records that look like one thing under two names, and a way to put them back together"
              onClick={() => {
                p.onDuplicates();
                close();
              }}
            />
          )}
          <PairPhoneButton asMenuItem onPaired={close} />
        </>
      )}
    </HeaderMenu>
  );
}

// The platform's web context for a workspace (@cobblr/platform-web): the
// record pieces, the action and field doors, the flows. One place, so the
// workspace shell (App.tsx) and a page drawn outside it that shows the
// workspace's own components (a Station tablet, #4640) give them the same
// context; the Station mounted the scan inbox's card without it and the card
// threw "usePlatformWeb called outside PlatformWebProvider".
import { lazy, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KERNEL_PANELS, PlatformWebProvider, type FlowRegistry } from "@cobblr/platform-web";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { api } from "./lib/api";
import { raiseBlockedAction } from "./lib/blocked-action";
import { decodeBarcodeImage } from "./lib/decode-barcode-image";
import { photoSuggestionsWhenOn } from "./lib/photoSuggestionsWhenOn";
import { FormBarcodeCapture } from "./components/FormBarcodeCapture";
import { RecordPhoto } from "./components/RecordPhoto";
import { CobbHead } from "./components/CobbHead";
// Flows load when one is opened (the flow host gives each a boundary).
const NewFromTemplateFlow = lazy(() => import("./flows/NewFromTemplateFlow").then((m) => ({ default: m.NewFromTemplateFlow })));
const OrganizeFlow = lazy(() => import("./flows/OrganizeFlow").then((m) => ({ default: m.OrganizeFlow })));
const ListShareFlow = lazy(() => import("./flows/ListShareFlow").then((m) => ({ default: m.ListShareFlow })));
const GroupTableFlow = lazy(() => import("./pages/ViewsPage").then((m) => ({ default: m.GroupTableFlow })));

// First-party flow registry: id → overlay the shell can open from anywhere
// (an action's `ui` directive, a view bulk-action, a nav entry). See
// docs/architecture/invokable-flows-and-lego-redesign.md.
const WORKSPACE_FLOWS: FlowRegistry = {
  "platform:share-list": ListShareFlow,
  "core-scan:organize": OrganizeFlow,
  "core-views:group-table": GroupTableFlow,
  "core-templates:create": NewFromTemplateFlow,
};

/** The platform's web context for a workspace: the record pieces, the
 *  action and field doors, the flows. The workspace shell mounts it, and so
 *  does a page drawn outside the shell that shows the workspace's own
 *  components (a Station tablet shows the scan inbox's card, #4640). */
export function WorkspacePlatformWeb({ orgSlug, role, appMode, children }: { orgSlug: string; role: OrgRoleName | null; appMode: boolean; children: ReactNode }) {
  const qc = useQueryClient();
  const activeSlug = orgSlug;
  return (
    <PlatformWebProvider
        orgSlug={activeSlug}
        role={role ?? null}
        appMode={!!appMode}
        flows={WORKSPACE_FLOWS}
        recordPhoto={RecordPhoto}
        barcodeCapture={FormBarcodeCapture}
        decodeBarcodeImage={decodeBarcodeImage}
        // The app owns what Cobb looks like; the package owns the button that
        // hands him a record.
        cobbIcon={CobbHead}
        api={{
          lookupBarcode: api.lookupBarcode,
          listActions: (slug, kind) => api.listActions(slug, kind),
          setRecordActionPin: (slug, kind, action, pinned) => api.setRecordActionPin(slug, kind, action, pinned),
          // A record's door to a module that is off (#3883): turning it on is an
          // owner's or admin's act; everyone else asks, through the one sheet.
          enableModule: (slug, name) => api.enableModule(slug, name),
          askForModule: async (slug, name, label) => {
            const { blocked } = await api.describeBlockedAction(slug, [{ kind: "module", key: name }], `Using ${label}`);
            raiseBlockedAction({ blocked, refused: null, subject: `Turn on ${label}` });
          },
          listFaces: (slug, kind) => api.listFaces(slug, kind),
          listNativeFieldOverrides: (slug, kind) => api.listNativeFieldOverrides(slug, kind),
          upsertOverride: (slug, body) => api.upsertOverride(slug, body),
          invokeAction: (slug, body) => api.invokeAction(slug, body),
          requestLight: (slug, ref, reason) => api.requestLight(slug, ref, reason),
          lookupEntity: (slug, kind, id) => api.lookupEntity(slug, kind, id),
          previewSendFile: api.previewSendFile, exportSendFile: api.exportSendFile, downloadSendFile: api.downloadSendFile, sendTargets: api.sendTargets, previewSend: api.previewSend, sendRecords: api.sendRecords, undoSend: api.undoSend,
          listShareOffers: (slug) => api.listShareOffers(slug),
          withdrawShareOffer: (slug, id) => api.withdrawShareOffer(slug, id),
          recordShares: (slug, kind, id) => api.recordShares(slug, kind, id),
          listSuggestions: (slug, q) => api.listSuggestions(slug, q),
          copyNotes: (slug, kind, id) => api.copyNotes(slug, kind, id),
          // Walk-up printing: platform-web needs the printer list to spot a
          // browser-driven default, and a way to call a module back once paper
          // exists. Both optional in the contract; wiring them turns it on.
          listPrinters: (slug) => api.listPrinters(slug),
          postToModulePath: (slug, path, body) => api.postToModulePath(slug, path, body),
          listEntities: (slug, kind, q) => api.listEntities(slug, kind, q),
          exportEntitiesCsv: (slug, kind, q, includeSecrets) => api.exportEntitiesCsv(slug, kind, q, includeSecrets),
          // Mapped down to {user_id, display_name}: platform-web has no business
          // knowing roles or join dates to draw a name in a picker.
          listMembers: async (slug) => ({
            items: (await api.listMembers(slug)).items.map((m) => ({
              user_id: m.user_id,
              display_name: m.display_name,
            })),
          }),
          listPeople: async (slug) => ({
            items: (await api.listPeople(slug)).items.map((p) => ({ id: p.id, name: p.name, member: p.member, left: p.left })),
          }),
          addPerson: async (slug, name) => {
            const p = await api.addPerson(slug, { name });
            return { id: p.id, name: p.name, member: p.member, left: p.left };
          },
          // The resolved read: a record shows its fields as the workspace
          // arranged them (relabelled, hidden, filed under sections).
          listBulkFieldOptions: api.listBulkFieldOptions,
          revealSecretField: api.revealSecretField,
          listFieldDefs: (slug, kind) => api.listFieldDefs(slug, kind, true),
          // Wires, through the same door as the Wires page: a module's offer to
          // make one ("add running-low items to a list") on a person's say-so.
          listWires: (slug) => api.listBindings(slug),
          createWire: (slug, wire) => api.createBinding(slug, { ...wire, target: "self", enabled: true }),
          deleteWire: (slug, id) => api.deleteBinding(slug, id),
          listWireEvents: (slug) => api.listWireEvents(slug),
          // Contributed panels: what ENABLED modules declare for other modules'
          // detail pages. platform-web renders them; this is the gate that keeps
          // a disabled module's panel off the page.
          listPhotoSuggestions: (slug, kind, ids) => photoSuggestionsWhenOn(qc, slug, kind, ids),
          searchPhotoFor: (slug, kind, id) => api.searchPhotoFor(slug, kind, id),
          listContributedPanels: (slug) =>
            api
              .orgModules(slug)
              .then((r) => [...KERNEL_PANELS, ...r.items.filter((m) => m.enabled).flatMap((m) => m.panels ?? [])]),
          fieldValues: (slug, kind, field, opts) => api.fieldValues(slug, kind, field, opts),
          addresses: (slug, q) => api.addresses(slug, q),
          sellerOffer: (slug, kind) => api.sellerOffer(slug, kind),
          listUnits: (slug) => api.listUnits(slug),
          addUnit: (slug, unit) => api.addUnit(slug, unit),
          deleteUnit: (slug, code) => api.deleteUnit(slug, code).then(() => undefined),
          setUnitDisplayMode: (slug, mode) => api.setUnitDisplayMode(slug, mode),
          // A collection's search shows what is waiting in the scan inbox to
          // come to it, judged and filed the way the inbox card does.
          // Loaded on first use: the inbox's judging rules are a page's worth of
          // code, and only a search that finds something waiting needs them.
          waitingScans: (slug, q, destination) => import("./lib/waitingScans").then((m) => m.waitingScans(qc, role ?? null, slug, q, destination)),
          fileWaitingScan: (slug, id) => import("./lib/waitingScans").then((m) => m.fileWaitingScan(qc, role ?? null, slug, id)),
          raiseBlocked: (blocked) => raiseBlockedAction({ blocked, refused: null, subject: null }),
          recordPublicPages: (slug, id) => api.recordPublicPages(slug, id),
          receivedFrom: (slug, kind, id) => api.receivedFrom(slug, kind, id),
          sendBackShareOffer: (slug, offerId) => api.sendBackShareOffer(slug, offerId),
        }}
    >
      {children}
    </PlatformWebProvider>
  );
}

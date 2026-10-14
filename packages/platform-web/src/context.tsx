// Shared platform-web context. The host (cobblr web app) wraps its
// authed surface in <PlatformWebProvider api={...} orgSlug={...} />
// so shared components like <EntityActionsBar> can resolve their
// dependencies.

import { createContext, Suspense, useCallback, useContext, useState, type ComponentType, type ReactNode } from "react";
import type { BarcodeCaptureProps } from "./BarcodeFill";
import type { PlatformWebApi } from "./types";
import { EntityPhoto } from "./EntityPhoto";

export interface RecordPhotoProps {
  kind: string;
  id: string;
  instance?: string | null;
  src: string | null | undefined;
  alt: string;
  brand?: string | null;
  size?: number;
  fit?: "cover" | "contain";
  onChange: (imagePath: string | null) => void;
  onSaved: () => void;
}

export function RecordPhoto(props: RecordPhotoProps) {
  const Photo = useContext(Ctx)?.recordPhoto;
  return Photo ? <Photo {...props} /> : <EntityPhoto src={props.src} alt={props.alt} size={props.size ?? 96} />;
}

/** Choosing a location, as a module page asks for one. The host supplies the
 *  platform's one picker (web/src/components/LocationTreePicker): a module UI
 *  cannot import it, and a module that drew its own <select> of locations
 *  offered a flat list with no rooms, shelves or bins in it (#6438). */
export interface LocationPickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
  placeholder?: string;
  /** What the "no place" row says: "No place", "All locations" for a filter. */
  noneLabel?: string;
  size?: "sm" | "md";
  className?: string;
  /** Offer the things that hold things (a Backpack, a toolbox) too, and hand
   *  the chosen one back: the page moves the record its own way. */
  onPickHolder?: (holder: PickedHolder) => void;
  /** The holder the record is inside now, shown as the selection. */
  pickedHolder?: PickedHolder | null;
}

/** A thing that holds things, as the picker offers and shows it. */
export interface PickedHolder {
  kind: string;
  id: string;
  title: string;
  /** "Desk drawer, in Office"; empty when it has no place of its own. */
  line: string;
}

/** The host's picker. The workspace shell always supplies it
 *  (lint:capabilities, photos:host-editor requires it); without a host, as in
 *  a test that mounts a page alone, the field says where it is and nothing more. */
export function LocationPicker(props: LocationPickerProps) {
  const Picker = useContext(Ctx)?.locationPicker;
  if (!Picker) return <span className="text-sm text-faint">{props.label ?? props.placeholder ?? "Location"}</span>;
  return <Picker {...props} />;
}

/** The same choice as an inline wrap of chips (the scan flow's picker,
 *  web/src/components/LocationChipPicker), for a list that sits inside a
 *  popover or sheet of its own: an area's chevron opens its shelves and bins. */
export interface LocationChipsProps {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Show the Recent row and a search box, for a long list of places. */
  withShortcuts?: boolean;
  className?: string;
}

export function LocationChips(props: LocationChipsProps) {
  const Chips = useContext(Ctx)?.locationChips;
  if (!Chips) return <span className="text-sm text-faint">Locations</span>;
  return <Chips {...props} />;
}

interface PlatformWebCtx {
  /** The host photo editor, including the shared web picker. */
  barcodeCapture?: ComponentType<BarcodeCaptureProps>;
  recordPhoto?: ComponentType<RecordPhotoProps>;
  locationPicker?: ComponentType<LocationPickerProps>;
  locationChips?: ComponentType<LocationChipsProps>;
  decodeBarcodeImage?: (file: File) => Promise<string | null>;
  api: PlatformWebApi;
  orgSlug: string;
  /** The viewer's role in the workspace ("owner" | "admin" | "member" | …),
   *  when the host knows it; shared UI hides a configuration write (a new
   *  dropdown choice) from a viewer the server would refuse. */
  role?: string | null;
  /** True when the active workspace is a LOCKED managed vertical app
   *  ("Cobblr for Yarn"). Lets shared/module UI trim platform-only chrome
   *  (e.g. the QR-label option) without importing the host's org context. */
  appMode: boolean;
  /** Cobb's head, drawn by the host. The package owns the button that puts a
   *  record in his context; the app owns what he looks like — the same split as
   *  `flows`, and the reason module UIs can show him without this package
   *  holding a copy of the artwork. */
  cobbIcon?: ComponentType<{ size?: number; title?: string }>;
}

const Ctx = createContext<PlatformWebCtx | null>(null);

// ─────────────────────────── Invokable flows ───────────────────────────
// A first-party "flow" is an interactive overlay (the organize planner, a
// future wizard) the shell can open FROM ANYWHERE by id — an action result's
// `ui` directive, a view bulk-action, a nav entry — without the caller knowing
// the component. The host app maps ids → components in a registry and passes it
// to PlatformWebProvider; shared components open one via useFlowHost().openFlow.
// See docs/architecture/invokable-flows-and-lego-redesign.md.

/** A flow component: rendered as a shell overlay, receives its opaque args and
 *  a close callback. Concrete flows live in the host app (web/src), never here
 *  — this package owns the MECHANISM, the app owns the components. */
export type FlowComponent = ComponentType<{ args: Record<string, unknown>; onClose: () => void }>;
export type FlowRegistry = Record<string, FlowComponent>;

interface FlowHostCtx {
  /** Open a registered flow. Unknown id (or no registry) → no-op, so returning
   *  a `ui` directive is always safe whether or not the shell honors it. */
  openFlow: (flowId: string, args?: Record<string, unknown>) => void;
}

const FlowCtx = createContext<FlowHostCtx>({ openFlow: () => {} });

export function useFlowHost(): FlowHostCtx {
  return useContext(FlowCtx);
}

export function PlatformWebProvider({
  api,
  orgSlug,
  role = null,
  appMode = false,
  flows,
  cobbIcon,
  recordPhoto,
  locationPicker,
  locationChips,
  decodeBarcodeImage,
  barcodeCapture,
  children,
}: {
  api: PlatformWebApi;
  orgSlug: string;
  barcodeCapture?: ComponentType<BarcodeCaptureProps>;
  recordPhoto?: ComponentType<RecordPhotoProps>;
  locationPicker?: ComponentType<LocationPickerProps>;
  locationChips?: ComponentType<LocationChipsProps>;
  decodeBarcodeImage?: (file: File) => Promise<string | null>;
  role?: string | null;
  appMode?: boolean;
  cobbIcon?: ComponentType<{ size?: number; title?: string }>;
  /** id → flow component. Omit to disable flows (openFlow becomes a no-op). */
  flows?: FlowRegistry;
  children: ReactNode;
}) {
  const [active, setActive] = useState<{ flow: string; args: Record<string, unknown> } | null>(null);
  const openFlow = useCallback(
    (flowId: string, args: Record<string, unknown> = {}) => {
      if (flows && flows[flowId]) setActive({ flow: flowId, args });
      // Unknown flow / no registry: ignore. A caller returning a ui directive
      // for a flow this shell doesn't host must not crash.
    },
    [flows],
  );
  const Active = active && flows ? flows[active.flow] : null;
  return (
    <Ctx.Provider value={{ api, orgSlug, role, appMode, cobbIcon, recordPhoto, locationPicker, locationChips, decodeBarcodeImage, barcodeCapture }}>
      <FlowCtx.Provider value={{ openFlow }}>
        {children}
        {/* A flow may be a lazy component (the shell loads a flow's code when it
            is opened, not with every page): its own boundary, so the page
            behind it never falls back. */}
        {active && Active && (
          <Suspense fallback={null}>
            <Active args={active.args} onClose={() => setActive(null)} />
          </Suspense>
        )}
      </FlowCtx.Provider>
    </Ctx.Provider>
  );
}

/** The viewer's role, or null outside a provider (a panel rendered on its
 *  own, a test): what decides whether an owner's control is offered. */
export function useViewerRole(): string | null {
  return useContext(Ctx)?.role ?? null;
}

/** The workspace the surface is drawn for, or null outside a provider. */
export function useActiveWorkspaceSlug(): string | null {
  return useContext(Ctx)?.orgSlug ?? null;
}

export function usePlatformWeb(): PlatformWebCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatformWeb called outside PlatformWebProvider");
  return v;
}

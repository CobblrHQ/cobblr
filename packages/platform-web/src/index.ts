// Public exports for the shared web components package.
export { JsonField, evaluateJson, type JsonFieldProps, type JsonEval } from "./JsonField";

export {
  PlatformWebProvider,
  usePlatformWeb,
  useFlowHost,
  type FlowComponent,
  type FlowRegistry,
} from "./context";
export { EntityActionsBar } from "./EntityActionsBar";
export { EntityChip } from "./EntityChip";
export { EntityThumb } from "./EntityThumb";
export {
  wantsSwatch,
  colorSwatch,
  swatchHex,
  resolveSwatchHex,
  pickThumb,
  type SwatchFieldDef,
  type ThumbChoice,
} from "./swatch";
export {
  buildLocationForest,
  flattenLocationForest,
  makeAreaResolver,
  groupContainersByArea,
  ancestorIds,
  flattenAreaForest,
  LOCATION_GROUP_KEY,
  type LocationNode,
  type LocationAccessors,
  type FlatLocation,
  type AreaContainerGroup,
} from "./locationTree";
export { EntityTile } from "./EntityTile";
export { ViewModeToggle, useViewMode, type ViewMode } from "./ViewModeToggle";
export { useImageSrc } from "./useImageSrc";
export { BulkActionBar } from "./BulkActionBar";
export { CustomFieldsPanel, RelationSelect } from "./CustomFieldsPanel";
export { EditableCell, type EditableCellDef } from "./EditableCell";
export {
  isForeign,
  byPriorityThenRecent,
  type FeedbackSource,
  type FeedbackSourceItem,
  type FeedbackUpdate,
} from "./feedback-source";
export { FeedbackCard, PriorityChip, FEEDBACK_STATUSES, fbStatusLabel } from "./FeedbackCard";

export { fieldControl, type FieldControl } from "./fieldControl";
export { relativeTime } from "./relativeTime";
export { FieldRenderer, boolLabel, boolTruthy, NoImage } from "./FieldRenderer";
export {
  NOTE_SUFFIX,
  canCarryNote,
  isNoteKey,
  noteKey,
  noteOf,
  valueWithNote,
} from "./field-note";
export { Markdown, stripMarkdown } from "./Markdown";
export { MarkdownEditor } from "./MarkdownEditor";
export { QrCode } from "./QrCode";
export {
  FilePreview,
  registerFilePreviewRenderer,
  unregisterFilePreviewRenderer,
  useFilePreviewRegistry,
  canPreviewFile,
  type PreviewRendererProps,
} from "./filePreview";
export { SandboxedRenderer, registerSandboxedRenderer } from "./SandboxedRenderer";
export {
  DashboardTile,
  TileCollapseContext,
  registerDashboardWidget,
  unregisterDashboardWidget,
  useDashboardWidgets,
  type DashboardWidgetProps,
  type DashboardWidgetSpec,
  type DashboardInstance,
  type TileCollapse,
} from "./dashboardWidgets";
export { BackToTop } from "./BackToTop";
export { CatalogTypeahead, type CatalogTypeaheadHit } from "./CatalogTypeahead";
export { usePageTitle } from "./usePageTitle";
export { usePublishChatContext, getChatPageContext, type ChatPageContext } from "./chat-context";
// Contributed detail panels — a module putting UI on another module's detail
// page without either side importing the other. Host registers components,
// manifests declare placement.
export {
  ContributedDetailPanels,
  useContributedDetailPanels,
  registerDetailPanel,
  unregisterDetailPanel,
  hasDetailPanel,
  type EntityDetailPanelCtx,
  type ContributedPanelSpec,
  type DetailPanelComponent,
} from "./panels";
export { Modal } from "./Modal";
export { ContentsPanel } from "./ContentsPanel";
export { ToastProvider, useToast } from "./ToastContext";
export { ConfirmProvider, useConfirm } from "./ConfirmContext";
export { UnitInput } from "./UnitInput";
export { useUnits, type UseUnits } from "./useUnits";
export { formatQuantity, formatUnit, resolveUnit, convertQuantity } from "./units";
export type {
  FieldRendererId,
  FieldType,
  PlatformAction,
  PlatformActionBinding,
  PlatformFieldDef,
  PlatformResolvedEntity,
  PlatformWebApi,
  PlatformUnitDef,
  PlatformUnitInput,
  PlatformUnitVocabulary,
  UnitDisplayMode,
} from "./types";

// Browser Bluetooth label printing. Shared because two surfaces print: the
// Printers config page (test print) and the labels queue (your real labels).
export {
  isWebBluetoothAvailable, NO_WEB_BLUETOOTH,
  connectPrinter, closePrinter, printToSession, printBatchOverBluetooth,
  printLabelOverBluetooth, renderLabelBitmap, labelLayoutFor, fitCaptionPx, captionBox, encodeForPrinter,
  // Walk-up: a session held across prints, so one label at a time costs
  // neither a chooser nor a reconnect.
  heldPrinterSession, printOneOverBluetooth, heldPrinterName, releaseHeldPrinter,
  // Inline connect: pair + auto-detect a known model, then persist it with no hand-entry.
  pairBluetoothPrinter, settingsFromProfile,
  // Labels per feed for a printer's loaded media (n-up), so an accumulate loop
  // knows how many labels fill one sheet.
  tileCount,
  type BluetoothPrinterSettings, type LabelContent, type PrinterSession,
  type BatchItem, type BatchResult,
} from "./bluetooth-label";

// Live progress of the print batch in flight — a taskbar-style count for the
// Live-box printer icon. Bluetooth publishes it per label from
// printBatchOverBluetooth; a network send publishes a transient count around the
// job submit via setPrintProgress. Read by the Live box.
export {
  getPrintProgress, setPrintProgress, subscribePrintProgress, usePrintProgress,
  type PrintProgress,
} from "./print-progress";

// The generic print directive: how a module asks the platform to put something
// on paper without either side learning the other's job.
export {
  runPrintDirective, printDirectiveOf,
  type PrintDirective, type PrintDirectiveResult,
} from "./print-directive";

// Serial (Web Serial) printing — for Bluetooth CLASSIC / SPP label printers a
// browser cannot reach over Web Bluetooth. Shares renderLabelBitmap +
// encodeForPrinter with the Bluetooth path; only the pipe differs.
export {
  isWebSerialAvailable, NO_WEB_SERIAL,
  pairSerialPrinter, heldSerialSession, heldSerialPrinterOpen, releaseHeldSerialPrinter,
  printOneOverSerial, printBatchOverSerial, identifySerialPrinter, readSerialPrinterStatus,
  type SerialSession, type SerialBatchItem, type SerialBatchResult, type SerialPortLike,
  type SerialPrinterIdentity,
} from "./serial-printer.js";

// Testing a bridge on the user's own machine — the server cannot reach it.
export {
  isLocalBridgePrinter, testLocalBridge, clientFor, readLocalBridgeStatus, printerDisplayName, bridgeInstanceInfo,
  discoverLocalPrinters, LOCAL_BRIDGE_URL, LABEL_PRINTER_DRIVERS, type DiscoveredPrinter,
} from "./bridge-printer.js";

// Turns a browser pairing failure into something actionable — notably Chrome's
// "Unsupported device.", which is the signature of a Bluetooth CLASSIC printer
// that needs the serial route rather than a defective one.
export { explainPairingFailure, type PairingFailure, type PairingRemedy } from "./pairing-errors.js";

// ONE door for connecting a label printer. The Bluetooth-vs-serial split is our
// transport detail, never the user's choice — see the file header.
export {
  getPrinterStatus, setPrinterStatus, clearPrinterStatus, subscribePrinterStatus,
  usePrinterStatus, describePrinterStatus, type PrinterStatusReading,
  reportedMedia, needsReportedRemember, describeReportedMedia, type ReportedMedia,
} from "./printer-status.js";
// How a printer is REACHED — what tells two entries for one machine apart.
export {
  printerReach, printerConnectionLabel, isTabHeldConnection, hasDuplicateName,
  type PrinterReach,
} from "./printer-connection.js";
// The local bridge's live view — what it holds, and the controls to change it.
export {
  useBridgeLive, readBridgeLive, setBridgeLink,
  type BridgeLive, type BridgeInstanceLive, type BridgeLinkState,
} from "./bridge-live.js";
export { BridgePrinterCard } from "./BridgePrinterCard";
export { BatteryGauge, PrinterReadout, batteryTone } from "./BatteryGauge";
export { ConnectPrinterModal, type ConnectPrinterModalProps, type ConnectPrinterInput } from "./ConnectPrinterModal";
export { MoveToInstanceModal, type MoveToInstanceModalProps } from "./MoveToInstanceModal";
export { AssortmentCard, type AssortmentCardProps, type AssortmentKind } from "./AssortmentCard";
export { scrimAlpha, scrimAlphaFor, percentileLuma } from "./photo-scrim";
export { HIDE_WHEN_OVERLAY_OPEN, OverlayFlag, useOverlayOpenFlag } from "./overlay-open";
export { LiveSurfaceProvider, useOverLiveSurface } from "./live-surface";

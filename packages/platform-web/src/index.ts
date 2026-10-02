// Public exports for the shared web components package.
export { JsonField, evaluateJson, type JsonFieldProps, type JsonEval } from "./JsonField";

export {
  PlatformWebProvider,
  usePlatformWeb, useViewerRole,
  useFlowHost,
  type FlowComponent,
  type FlowRegistry,
} from "./context";
export { EntityActionsBar } from "./EntityActionsBar";
export { RecordHeaderChips } from "./RecordHeaderChips";
export { RecordDisposition } from "./RecordDisposition";
export { BulkGiveTo } from "./BulkGiveTo";
export { RecordFaces, FaceSection, FacesOn, faceShows, useFaces, useFaceOn } from "./faces";
export { useInvokeEntityAction } from "./use-invoke-action";
export { useLater, type Later } from "./use-later";
export { useFieldDraft, type FieldDraft } from "./use-field-draft";
export { useFieldPresentation, PresentationGate, type FieldPresentation } from "./field-presentation";
export { runAction, useRunAction, refreshAfterAction, queryShowsKinds, affectedKindsOf, type ActionBody, type ActionRun, type ActionAffected, type KindMeta } from "./run-action";
export { changeWorkspaceShape, useChangeWorkspaceShape, afterWorkspaceShapeChange, queryFollowsWorkspaceShape, type ShapeMeta, type ChangeShapeOptions } from "./workspace-shape";
export { ActionOutcome } from "./ActionOutcome";
export { AskBeforeRun, type Asking } from "./AskBeforeRun";
export { summariseParts, summaryLine, type TileSummary } from "./tileSummary";
export { EntityChip } from "./EntityChip";
export { EntityThumb } from "./EntityThumb";
export { Swatch } from "./Swatch";
export { ColourInput } from "./ColourInput";
export { EntityPhoto, type EntityPhotoProps, type PhotoAspect } from "./EntityPhoto";
export {
  wantsSwatch,
  colorSwatch,
  swatchHex,
  swatchFill,
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
export { EntityTile, TILE_GRID, TILE_TITLE, distinctSubtitle, countBadge } from "./EntityTile";
export { ViewModeToggle, useViewMode, type ViewMode } from "./ViewModeToggle";
export { reloadPicture, useImageSrc } from "./useImageSrc";
export { brokenPictureCount, reportBrokenPicture } from "./brokenPictures";
export { walkPages, type WalkedList } from "./list-pages";
export { openAuthedFile, type OpenAuthedFileOptions } from "./openAuthedFile";
export { FileIntake, FileIntakePanels, useFileIntake, describeLine, type IntakeLine, type FileIntakeOptions } from "./FileIntake";
export { sendUpload, uploadErrorOf, uploadJson, UploadError, type SendUploadOptions } from "./upload-client";
export { TableFileIntake, intakeSummary, type TableFileIntakeResult, type AskField } from "./TableFileIntake";
export { SnippetText } from "./SnippetText";
export { TableConnectorImport, importSummary, type SectionOutcome } from "./TableConnectorImport";
export { MutationError, errorSentence } from "./MutationError";
export { PasswordInput, SecretInput, AddressInput, NOT_A_LOGIN, type PasswordInputProps } from "./PasswordInput";
export { NounChoiceButtons, nounChoiceHeading } from "./NounChoice";
export { BulkActionBar } from "./BulkActionBar";
export { useTickedRows, tickedRowsKey, type ClearForUndo } from "./ticked-rows";
export { SelectableTile, SELECTED_TILE, type SelectableTileProps } from "./SelectableTile";
export { PhotoSourceBadge, AiMark } from "./PhotoSourceBadge";
export { FooterActionPopover, type FooterActionPopoverProps } from "./FooterActionPopover";
export { BulkTagAction } from "./BulkTagAction";
export { PlacePickList, readRecentPlaces, noteRecentPlace, type PlaceChoice } from "./PlacePickList";
export { CustomFieldsPanel, RelationSelect } from "./CustomFieldsPanel";
export { TipLine, pickTip, registerTip, registeredTips, type Tip, type TipState, type TipStripProps } from "./tips";
export { useRecordInPath, type RecordInPathOptions } from "./useRecordInPath";
export { EditableCell, type EditableCellDef } from "./EditableCell";
export {
  isForeign,
  byPriorityThenRecent,
  type FeedbackSource,
  type FeedbackSourceItem,
  type FeedbackUpdate,
} from "./feedback-source";
export { FeedbackCard, PriorityChip, FEEDBACK_STATUSES, fbStatusLabel } from "./FeedbackCard";

export { fieldControl, fieldInputText, valueFromInput, type FieldControl, type FieldValueDef } from "./fieldControl";
export { MoneyInput, type MoneyInputProps } from "./MoneyInput";
export { packFields, fieldNeed, MIN_COL_PX, GAP_PX, type FieldNeed, type FieldSpace, type FieldPacking, type PackedCell, type PackOptions } from "./field-pack";
export { FieldPack, fieldPackControlClass, type FieldPackItem } from "./FieldPack";
export { EditField, EditSelect, FieldLabel, LabeledField, editFieldNeed, editFieldItem, editFieldText, moneyFieldItem, usedValueFieldItem, type EditFieldProps } from "./EditField";
export { relativeTime } from "./relativeTime";
export { FieldRenderer, boolLabel, boolTruthy, NoImage } from "./FieldRenderer";
export {
  NOTE_SUFFIX,
  canCarryNote,
  offersClarifier,
  isNoteKey,
  noteKey,
  noteOf,
  valueWithNote,
} from "./field-note";
export { Markdown, stripMarkdown } from "./Markdown";
export { MarkdownEditor } from "./MarkdownEditor";
export { QrCode } from "./QrCode";
export { DocThumb, docThumbFor } from "./DocThumb";
export {
  FilePreview,
  registerFilePreviewRenderer,
  registerFileThumbRenderer,
  thumbDrawerFor,
  type ThumbDrawer,
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
export { usePageWidth, type PageWidth } from "./usePageWidth";
export { useCreateDoor, CREATE_PARAM } from "./useCreateDoor";
export { AskCobbAbout } from "./AskCobbAbout";
export { ContextChip } from "./ContextChip";
export { openDiscussion, discussionRecordOf, type DiscussionRecord } from "./open-discussion";
export { RecordRow, recordRowMarks } from "./RecordRow";
export { toggleRecordInContext, nounForKind, labelForSet } from "./toggle-record-context";
export {
  usePublishChatContext,
  getChatPageContext,
  type ChatPageContext,
  type ChatSelection,
  getChatSelection,
  publishRowSelection,
  publishBarSelection,
  clearBarSelection,
  publishTextSelection,
  clearChatSelection,
  useChatSelection,
  usePublishRowSelection,
  useAskCobbAboutSelection,
  useSelectionResolver,
  subscribeChatSelection,
  resolveSelectionText,
  type ResolvedSelection,
} from "./chat-context";
// Contributed detail panels — a module putting UI on another module's detail
// page without either side importing the other. Host registers components,
// manifests declare placement.
export {
  ContributedDetailPanels,
  useContributedDetailPanels,
  registerDetailPanel,
  unregisterDetailPanel,
  hasDetailPanel,
  UNIVERSAL,
  KERNEL_PANELS,
  type EntityDetailPanelCtx,
  type ContributedPanelSpec,
  type DetailPanelComponent,
} from "./panels";
export { Modal } from "./Modal";
export { SHORTCUTS, isShortcut, keyCap, typingIn, OPEN_SHORTCUTS_EVENT, type Shortcut, type KeyLike } from "./shortcuts";
export { lockPageScroll, useLockPageScroll } from "./scrollLock";
export { ContentsPanel, useHoldsContents } from "./ContentsPanel";
export { ToastProvider, useToast, ERROR_WITHOUT_WORDS } from "./ToastContext";
export { ConfirmProvider, useConfirm } from "./ConfirmContext";
export { usePhotoPick, usePhotoCaptureHost, requestCapturedPhoto, photoFile, type PhotoRequest } from "./photo-capture";
export { UnitInput } from "./UnitInput";
export { InboxWaitingStrip } from "./InboxWaitingStrip";
export { PersonSelect, usePersonName, useMemberName } from "./PersonSelect";
export { useUnits, type UseUnits } from "./useUnits";
export { formatQuantity, formatUnit, resolveUnit, convertQuantity, unitLens, usedInUnit } from "./units";
export { AmountControl } from "./AmountControl";
export { StockStepper } from "./StockStepper";
export { StickyBottomBar } from "./StickyBottomBar";
export type {
  FieldRendererId,
  FieldType,
  PlatformAction,
  PlatformDormantAction,
  PlatformActionBinding,
  PlatformFieldDef,
  PlatformPerson,
  PlatformResolvedEntity,
  PlatformWebApi,
  PlatformWaitingScan,
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
  printLabelOverBluetooth, renderLabelBitmap, renderLabelPng, labelLayoutFor, fitCaptionPx, captionBox, encodeForPrinter,
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
export { MoveToInstanceModal, MoveToInstancePanel, type MoveToInstanceModalProps, type MoveToInstancePanelProps } from "./MoveToInstanceModal";
export { AssortmentCard, type AssortmentCardProps, type AssortmentKind } from "./AssortmentCard";
export { scrimAlpha, scrimAlphaFor, percentileLuma } from "./photo-scrim";
export { HIDE_WHEN_OVERLAY_OPEN, HIDE_WHEN_COVERED, OverlayFlag, useOverlayOpenFlag } from "./overlay-open";
export { downloadBlob } from "./download-blob";
export { withPngDpi, readPngDpi, isPng, crc32, dpiToPixelsPerMetre } from "./png-dpi";
export { YIELDING_CLASS, useYieldToContent, pressableBeneath, samplePoints } from "./yield-to-content";
export { FloatingChrome, type FloatingChromeProps, type FloatingAnchor } from "./FloatingChrome";
export { registerBottomChrome, registerCornerChrome, stackBottomChrome, stackCorner, cornerSide, bottomClearance, layoutDockNow, BOTTOM_CHROME_HEIGHT_VAR, BOTTOM_CLEARANCE_VAR, CORNER_STACK, CORNER_GAP, CORNER_STACK_VAR } from "./bottom-dock";
export { useLayerStack, topLayerZ, stackedZ, isTopLayer, inTopLayer } from "./layer-stack";
export { useDialogFocus, tabbables } from "./useDialogFocus";
export { DragInput, type DragInputProps } from "./DragInput";
export { OverlayLayer, PopoverLayer, BackdropLayer, clampToViewport, POPOVER_GUTTER, OVERLAY_LAYER_CLASS, POPOVER_LAYER_CLASS, BACKDROP_LAYER_CLASS, type LayerProps, type PopoverLayerProps } from "./fixed-layers";
export { LiveSurfaceProvider, useOverLiveSurface } from "./live-surface";
export { describeUnreadableBody } from "./unreadableBody";

// The one door to a local address from the browser (see local-network.ts).
export {
  localFetch, isLocalAddress, localAccessAllowed, allowLocalAccess, revokeLocalAccess, LocalAccessDenied,
} from "./local-network.js";
export { viewCardFields, CARD_FIELDS_ON_CARD, type ViewCardFields } from "./view-card-fields";
export { SearchInput, type SearchInputProps } from "./SearchInput";
export { CollectionHeader, HEADER_CONTROL, headerButton } from "./CollectionHeader";
export { ExportCsvButton } from "./ExportCsvButton";
export { usePhotoSuggestions, usePhotoSuggestionFor, suggestedSrcFor, pictureStateFor, PICTURE_STATE_TEXT, markShownBeside, useShownBeside } from "./photoSuggestions";
export type { PictureState } from "./photoSuggestions";
export type { PhotoSuggestionRow } from "./types";
export { Lightbox, type LightboxItem, type LightboxProps, type LightboxVerb } from "./Lightbox";
export { OverlayCloseButton } from "./OverlayCloseButton";
export { acceptsFile, clipboardFiles, clipboardImageFiles, imageUrlFrom, payloadFromClipboard, readPastedImage, type PastedImage, type PastedPayload } from "./pastedImage";
export { usePasteImage, pasteTargetFor, type PasteImageHandlers } from "./usePasteImage";
export { useEscapeToClose } from "./useEscapeToClose";
export { QueryError } from "./QueryError";
export { missingRequired, type RequiredLike } from "./required-fields";
export type { PlatformWire, PlatformWireInput } from "./types";
export type { FieldValuesUsedBody, UsedValueBody } from "./types";
export { noteWorkspaceWrite, subscribeWorkspaceWrite, refreshStockViews, STOCK_VIEW_KEYS, STOCK_LIST_KEYS, type WorkspaceWriteListener } from "./workspace-writes";
export { ChoiceCombobox, matchChoice, orderChoices, type ChoiceComboboxProps, type ChoiceDetail, type ChoiceOption } from "./ChoiceCombobox";
export { ChoiceField, detailOptions, type ChoiceFieldProps, type ChoiceFieldDef } from "./ChoiceField";
export { UsedValueInput, type UsedValueInputProps } from "./UsedValueInput";

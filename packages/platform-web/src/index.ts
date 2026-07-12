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
  type LocationNode,
  type LocationAccessors,
  type FlatLocation,
} from "./locationTree";
export { EntityTile } from "./EntityTile";
export { ViewModeToggle, useViewMode, type ViewMode } from "./ViewModeToggle";
export { useImageSrc } from "./useImageSrc";
export { BulkActionBar } from "./BulkActionBar";
export { CustomFieldsPanel, RelationSelect } from "./CustomFieldsPanel";
export { fieldControl, type FieldControl } from "./fieldControl";
export { relativeTime } from "./relativeTime";
export { FieldRenderer, boolLabel, NoImage } from "./FieldRenderer";
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
export { Modal } from "./Modal";
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

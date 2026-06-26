// Public exports for the shared web components package.
export { JsonField, evaluateJson, type JsonFieldProps, type JsonEval } from "./JsonField";

export { PlatformWebProvider, usePlatformWeb } from "./context";
export { EntityActionsBar } from "./EntityActionsBar";
export { EntityChip } from "./EntityChip";
export { EntityThumb } from "./EntityThumb";
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
export { CustomFieldsPanel } from "./CustomFieldsPanel";
export { fieldControl, type FieldControl } from "./fieldControl";
export { FieldRenderer, boolLabel, NoImage } from "./FieldRenderer";
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
  registerDashboardWidget,
  unregisterDashboardWidget,
  useDashboardWidgets,
  type DashboardWidgetProps,
  type DashboardWidgetSpec,
  type DashboardInstance,
} from "./dashboardWidgets";
export { BackToTop } from "./BackToTop";
export { CatalogTypeahead, type CatalogTypeaheadHit } from "./CatalogTypeahead";
export { usePageTitle } from "./usePageTitle";
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

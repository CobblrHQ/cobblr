// Public exports for the shared web components package.

export { PlatformWebProvider, usePlatformWeb } from "./context";
export { EntityActionsBar } from "./EntityActionsBar";
export { EntityChip } from "./EntityChip";
export { EntityThumb } from "./EntityThumb";
export { EntityTile } from "./EntityTile";
export { ViewModeToggle, useViewMode, type ViewMode } from "./ViewModeToggle";
export { useImageSrc } from "./useImageSrc";
export { BulkActionBar } from "./BulkActionBar";
export { CustomFieldsPanel } from "./CustomFieldsPanel";
export { FieldRenderer, NoImage } from "./FieldRenderer";
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
} from "./dashboardWidgets";
export { BackToTop } from "./BackToTop";
export { CatalogTypeahead, type CatalogTypeaheadHit } from "./CatalogTypeahead";
export { usePageTitle } from "./usePageTitle";
export { Modal } from "./Modal";
export { ToastProvider, useToast } from "./ToastContext";
export { ConfirmProvider, useConfirm } from "./ConfirmContext";
export { UnitInput } from "./UnitInput";
export { useUnits, type UseUnits } from "./useUnits";
export { formatQuantity, formatUnit, resolveUnit } from "./units";
export type {
  FieldRendererId,
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

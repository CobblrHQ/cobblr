// Public exports for the shared web components package.

export { PlatformWebProvider, usePlatformWeb } from "./context";
export { EntityActionsBar } from "./EntityActionsBar";
export { EntityChip } from "./EntityChip";
export { CustomFieldsPanel } from "./CustomFieldsPanel";
export { Modal } from "./Modal";
export { ToastProvider, useToast } from "./ToastContext";
export { ConfirmProvider, useConfirm } from "./ConfirmContext";
export type {
  PlatformAction,
  PlatformActionBinding,
  PlatformFieldDef,
  PlatformResolvedEntity,
  PlatformWebApi,
} from "./types";

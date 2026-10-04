import type { ComponentProps } from "react";
import { Modal } from "./Modal";

export function RecordFormModal(props: Omit<ComponentProps<typeof Modal>, "size" | "recordForm"> & { size?: never; recordForm?: never }) {
  return <Modal {...props} recordForm />;
}

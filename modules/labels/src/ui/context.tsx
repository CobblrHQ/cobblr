import { createContext, useContext, useMemo, type ReactNode } from "react";
import { LabelsApi } from "./api";

interface LabelsCtx {
  orgSlug: string;
  api: LabelsApi;
}

const Ctx = createContext<LabelsCtx | null>(null);

export function LabelsProvider({
  orgSlug,
  getToken,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  children: ReactNode;
}) {
  const api = useMemo(() => new LabelsApi(orgSlug, { getToken }), [orgSlug, getToken]);
  return <Ctx.Provider value={{ orgSlug, api }}>{children}</Ctx.Provider>;
}

export function useLabels(): LabelsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLabels called outside LabelsProvider");
  return v;
}

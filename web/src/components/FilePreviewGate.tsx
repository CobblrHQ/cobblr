// Host-level integration (NOT a module): turns the fabrication file
// renderers (STL / G-code) on only when a machine domain is enabled — the
// same pattern the nav uses to gate the scan affordance on core-scan
// (useNavModules.enabledNames). `core-file-preview` stays domain-agnostic;
// the host does the wiring here, the way a bundle is the one thing allowed
// to know about two modules. Disable the domain → the renderers turn off.
//
// Note: STL is also useful to makers tracking printable parts in inventory
// without a machine module — that edge is what installable renderers
// (the next phase) solve. For now, fabrication domains are the gate.

import { useEffect } from "react";
import {
  registerFabricationRenderers,
  unregisterFabricationRenderers,
} from "@cobblr/core-file-preview/ui";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useNavModules } from "./useNavModules";

const FABRICATION_DOMAINS = ["machines", "digifab"];

export function FilePreviewGate() {
  const { activeSlug } = useActiveOrg();
  const { enabledNames } = useNavModules(activeSlug ?? "");
  const fabEnabled = FABRICATION_DOMAINS.some((m) => enabledNames.has(m));
  useEffect(() => {
    if (fabEnabled) registerFabricationRenderers();
    else unregisterFabricationRenderers();
  }, [fabEnabled]);
  return null;
}

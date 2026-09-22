// Registers the active workspace's INSTALLED renderers (core-file-preview)
// into the FilePreview registry, each as a sandboxed loader. The renderer
// JS is untrusted — registerSandboxedRenderer wraps it in the opaque-origin
// iframe (SandboxedRenderer). Re-syncs when the workspace or its installed
// set changes. Host-level wiring, like FilePreviewGate.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { registerSandboxedRenderer, unregisterFilePreviewRenderer } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { frameDocUrl } from "../lib/frame-doc";

export function InstalledRenderers() {
  const { activeSlug } = useActiveOrg();
  const installed = useQuery({
    queryKey: ["installed-renderers", activeSlug],
    queryFn: () => api.getInstalledRenderers(activeSlug!),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Track the exts we registered so we can cleanly drop them when the set
  // changes (workspace switch, uninstall).
  const registered = useRef<string[]>([]);
  const items = installed.data?.items;
  useEffect(() => {
    if (registered.current.length) {
      unregisterFilePreviewRenderer(registered.current);
      registered.current = [];
    }
    for (const r of items ?? []) {
      // The third argument is what lets the frame come from a URL instead of
      // srcdoc, so an enforced `script-src 'self'` does not stop every
      // installed renderer from drawing (#3300).
      registerSandboxedRenderer(r.exts, r.renderer_js, (html) => frameDocUrl(html, "renderer"));
      registered.current.push(...r.exts);
    }
    return () => {
      if (registered.current.length) {
        unregisterFilePreviewRenderer(registered.current);
        registered.current = [];
      }
    };
  }, [items]);
  return null;
}

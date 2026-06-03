// Sandboxed host for third-party (installed) file-preview renderers — the
// security core of installable renderers (extension-registry.md). A
// renderer is untrusted CODE, so it runs in an OPAQUE-ORIGIN iframe and
// gets the file bytes by postMessage; it can never reach the parent, the
// API token, cookies, localStorage, or the network. The Tier-B pattern,
// applied to rendering.
//
// Hard boundaries (defence in depth):
//  • sandbox="allow-scripts" ONLY — no allow-same-origin → the frame is a
//    unique opaque origin: cross-origin to us, so it can't touch our DOM,
//    storage, or cookies, and holds no auth.
//  • CSP `default-src 'none'` (+ inline script/style, data:/blob: images)
//    → NO connect-src → the renderer can't fetch/XHR/exfiltrate. It only
//    ever sees the bytes we hand it.
//  • The only channel is postMessage, tagged `__cfp` and type-checked.
//  • A render deadline turns a hung/garbage renderer into a clean error.
//
// The renderer bundle is JS that calls `cobblr.onRender((file, canvas) =>
// …)`; we provide the canvas + the bytes, it draws (three.js/WebGL works
// in this sandbox). Worst case a malicious renderer draws nonsense in its
// own box — it can do nothing else.

import { useEffect, useRef, useState } from "react";
import {
  registerFilePreviewRenderer,
  type PreviewRendererProps,
} from "./filePreview";

export interface SandboxedRendererProps {
  /** The renderer's JS bundle (untrusted). Runs in the opaque-origin frame. */
  rendererJs: string;
  bytes: ArrayBuffer;
  filename: string;
  /** Initial frame height; the renderer can grow it via cobblr.setHeight(). */
  height?: number;
}

// The injected SDK — the trusted half inside the frame. Bridges our
// postMessage protocol to the renderer's draw function and reports back.
const SDK = `
(function(){
  var renderFn = null;
  window.cobblr = {
    onRender: function(fn){ renderFn = fn; },
    setHeight: function(h){ try { parent.postMessage({__cfp:1,type:'height',height:Math.max(40,Math.min(4000,h|0))}, '*'); } catch(e){} }
  };
  window.addEventListener('message', async function(e){
    var d = e.data;
    if (!d || d.__cfp !== 1 || d.type !== 'render') return;
    var canvas = document.getElementById('cfp-canvas');
    try {
      if (typeof renderFn !== 'function') throw new Error('renderer did not call cobblr.onRender');
      await renderFn({ bytes: d.bytes, filename: d.filename, width: d.width, height: d.height }, canvas);
      parent.postMessage({__cfp:1,type:'ready'}, '*');
    } catch(err){
      parent.postMessage({__cfp:1,type:'error',message:String(err && err.message || err)}, '*');
    }
  });
  parent.postMessage({__cfp:1,type:'loaded'}, '*');
})();`;

function buildSrcDoc(rendererJs: string, w: number, h: number): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
  // The renderer JS is inlined verbatim — it's already constrained by the
  // sandbox + CSP, so no escaping is needed beyond closing-tag safety.
  const safe = rendererJs.replace(/<\/script>/gi, "<\\/script>");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
    `#cfp-canvas{display:block;margin:0 auto}</style></head>` +
    `<body><canvas id="cfp-canvas" width="${w}" height="${h}"></canvas>` +
    `<script>${SDK}</script><script>${safe}</script></body></html>`
  );
}

const DEADLINE_MS = 12_000;

export function SandboxedRenderer({ rendererJs, bytes, filename, height = 420 }: SandboxedRendererProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [frameH, setFrameH] = useState(height);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");

  // Rebuild the frame whenever the renderer or file changes.
  const srcDoc = buildSrcDoc(rendererJs, 600, height);

  useEffect(() => {
    setStatus("loading");
    setErrMsg("");
    const iframe = ref.current;
    if (!iframe) return;
    let done = false;
    const deadline = window.setTimeout(() => {
      if (!done) {
        done = true;
        setStatus("error");
        setErrMsg("Renderer timed out");
      }
    }, DEADLINE_MS);

    const onMsg = (e: MessageEvent) => {
      // Only trust messages from THIS frame's window, tagged + typed.
      if (e.source !== iframe.contentWindow) return;
      const d = e.data as { __cfp?: number; type?: string; height?: number; message?: string };
      if (!d || d.__cfp !== 1) return;
      if (d.type === "loaded") {
        // Frame booted → hand it the bytes (clone, not transfer, so the
        // caller keeps its copy if it re-renders).
        iframe.contentWindow?.postMessage(
          { __cfp: 1, type: "render", bytes, filename, width: 600, height },
          "*",
        );
      } else if (d.type === "ready") {
        if (!done) { done = true; window.clearTimeout(deadline); setStatus("ready"); }
      } else if (d.type === "height" && typeof d.height === "number") {
        setFrameH(d.height);
      } else if (d.type === "error") {
        if (!done) { done = true; window.clearTimeout(deadline); setStatus("error"); setErrMsg(d.message || "Renderer error"); }
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      done = true;
      window.clearTimeout(deadline);
      window.removeEventListener("message", onMsg);
    };
  }, [rendererJs, bytes, filename, height]);

  return (
    <div className="relative">
      {status === "error" && (
        <div className="text-xs text-faint italic py-6 text-center">Preview failed{errMsg ? `: ${errMsg}` : ""}</div>
      )}
      <iframe
        ref={ref}
        title="file preview"
        // allow-scripts ONLY — opaque origin, no same-origin, no network.
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="w-full border-0 bg-transparent"
        style={{ height: status === "error" ? 0 : frameH }}
      />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-faint pointer-events-none">Rendering…</div>
      )}
    </div>
  );
}

/** Register an INSTALLED (third-party) renderer for some extensions — its
 *  untrusted JS runs in the sandbox above. The host calls this for each
 *  renderer the workspace has installed; consumers then preview those
 *  extensions exactly like a built-in one. */
export function registerSandboxedRenderer(exts: string[], rendererJs: string): void {
  registerFilePreviewRenderer(exts, () =>
    Promise.resolve({
      default: (props: PreviewRendererProps) => (
        <SandboxedRenderer rendererJs={rendererJs} bytes={props.bytes} filename={props.filename} />
      ),
    }),
  );
}

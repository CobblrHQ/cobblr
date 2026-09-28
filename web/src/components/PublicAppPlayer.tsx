// Read-only, no-login render of a composed App for a public surface
// (scope_type:"app"). The server (api/src/routes/public.ts) has already
// curated everything: it dropped write/member blocks (form/action/scan/
// record), resolved every view the app references into `data.viewsById`,
// precomputed each stat into `data.statsById`, and rewrote image paths to
// the no-auth public file route. So this player needs NO token and makes
// NO live calls — it renders the injected payload, and custom blocks read
// their data from an injected blob via a read-only `cobblr` SDK.
//
// It deliberately mirrors the member AppPlayerPage's look (themed,
// full-bleed) but shares none of its auth/data plumbing.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { EntityTile, TILE_GRID } from "@cobblr/platform-web";
import { publicFrameDocUrl } from "../lib/frame-doc";
import type { AppTheme, AppBlock, AppPage } from "../lib/api";
import { statKey } from "@cobblr/platform-contract/stat-value";
import {
  themeWrapperStyle,
  fontFaceCss,
  customFontUrl,
  CUSTOM_FONT_FAMILY,
  FONT_STACKS,
  cardStyle,
  accentStyle,
  mutedStyle,
  proseStyle,
} from "../lib/appTheme";

export interface PublicAppPayload {
  name: string;
  theme?: AppTheme | null;
  pages: AppPage[];
}
export interface PublicAppData {
  viewsById: Record<string, PublicItem[]>;
  statsById: Record<string, number>;
}
interface PublicItem {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  fields?: Record<string, unknown>;
}

// The read-only SDK injected into every custom block. No token, no
// network, no writes — it reads the injected data blob and refuses to
// mutate. Mirrors the member SDK's *shape* (mount/viewData/can/…) so a
// block authored for the member portal renders unchanged here.
const PUBLIC_SDK = `<script>(function(){
var D=window.__PUBLIC_DATA__||{};function P(v){return Promise.resolve(v);}
function ro(){return Promise.reject(new Error("read-only public view"));}
window.cobblr={
get:function(){return ro();},
viewData:function(id){return P((D.viewsById&&D.viewsById[id])||[]);},
entity:function(k,i){return P((D.entitiesById&&D.entitiesById[k+":"+i])||null);},
me:function(){return P({role:"public",grants:[]});},
can:function(){return P(false);},
invoke:ro,action:ro,
mount:function(t,loader,render){var el=typeof t==="string"?document.querySelector(t):t;if(!el)return P();el.textContent="Loading\\u2026";return P().then(loader).then(function(d){el.innerHTML="";render(el,d);}).catch(function(e){el.textContent="\\u26a0 "+((e&&e.message)||e);});}
};
})();</script>`;

/** A custom block, served FROM A URL rather than srcdoc (#3300).
 *
 *  A srcdoc document inherits this page's Content-Security-Policy, so with
 *  `script-src 'self'` enforced the injected SDK and the author's scripts are
 *  both refused and the block renders blank. The api hands back a one-shot URL
 *  whose own response permits inline script inside that document and nothing
 *  else; the surface token is the gate, the same one that served this page.
 *
 *  Without a token there is nothing to ask with, so the block says so rather
 *  than showing an empty rectangle. */
function CustomBlockFrame({ html, height, surfaceToken }: { html: string; height: number; surfaceToken?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    if (!surfaceToken) {
      setFailed(true);
      return;
    }
    publicFrameDocUrl(surfaceToken, html)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [html, surfaceToken]);
  if (failed)
    return (
      <div style={{ width: "100%", height, display: "grid", placeItems: "center", fontSize: 12, opacity: 0.6 }}>
        This block could not be prepared.
      </div>
    );
  if (!url)
    return (
      <div style={{ width: "100%", height, display: "grid", placeItems: "center", fontSize: 12, opacity: 0.6 }}>
        Loading…
      </div>
    );
  return (
    <iframe
      title="custom app"
      // Alongside the response's own sandbox policy: two ways of saying opaque
      // origin, so a browser honouring either one is safe.
      sandbox="allow-scripts"
      src={url}
      style={{ width: "100%", height, border: "none" }}
    />
  );
}

function customSrcDoc(html: string, theme: AppTheme | null | undefined, data: PublicAppData): string {
  const bodyBg = theme?.bg ?? "#ffffff";
  const bodyText = theme?.text ?? "#334155";
  const bodyFont = customFontUrl(theme)
    ? `'${CUSTOM_FONT_FAMILY}', system-ui, sans-serif`
    : theme?.font
      ? FONT_STACKS[theme.font]
      : "system-ui,-apple-system,sans-serif";
  const fontFace = fontFaceCss(theme) ?? "";
  // Escape "<" in the injected JSON so a "</script>" inside data can't
  // break out of the inline <script>.
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>${fontFace}body{font-family:${bodyFont};margin:0;padding:14px;color:${bodyText};background:${bodyBg};font-size:14px}</style>` +
    `<script>window.__PUBLIC_DATA__=${dataJson};</script>${PUBLIC_SDK}</head><body>${html}</body></html>`
  );
}

function StatBlock({ block, data, theme }: { block: Extract<AppBlock, { type: "stat" }>; data: PublicAppData; theme: AppTheme | null | undefined }) {
  const key = statKey(block.view_id, block);
  const n = data.statsById[key] ?? 0;
  return (
    <div className="rounded-xl border p-4 min-w-[120px]" style={cardStyle(theme)}>
      <div className="text-3xl font-extrabold" style={accentStyle(theme)}>{n}</div>
      {block.label && (
        <div className="text-[10px] font-mono uppercase tracking-widest mt-1" style={mutedStyle(theme)}>{block.label}</div>
      )}
    </div>
  );
}

function ViewBlock({ block, data, theme }: { block: Extract<AppBlock, { type: "view" }>; data: PublicAppData; theme: AppTheme | null | undefined }) {
  const items = data.viewsById[block.view_id] ?? [];
  return (
    <div>
      {block.title && (
        <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={mutedStyle(theme)}>{block.title}</div>
      )}
      {items.length === 0 ? (
        <div className="text-sm italic" style={mutedStyle(theme)}>nothing here.</div>
      ) : (
        <div className={TILE_GRID}>
          {items.map((i) => (
            <EntityTile key={`${i.kind}:${i.id}`} src={i.image_path} title={i.title} subtitle={i.subtitle ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

// A light, high-contrast palette for e-paper surfaces — reflective panels read
// best as black-on-white. Overrides the app's own theme (keeps its font/radius)
// so a dark-themed app (e.g. the spice cabinet) still renders crisp on e-paper.
const EPAPER_THEME = (base: AppTheme | null): AppTheme => ({
  ...(base ?? {}),
  bg: "#ffffff",
  surface: "#ffffff",
  text: "#111111",
  muted: "#555555",
  border: "#999999",
  accent: "#111111",
  accent_text: "#ffffff",
});

export function PublicAppPlayer({
  app,
  data,
  epaper,
  surfaceToken,
}: {
  app: PublicAppPayload;
  data: PublicAppData;
  epaper?: boolean;
  /** The surface's own token, from the URL this page was opened with. A custom
   *  block needs it to ask for its frame document (#3300); this page holds no
   *  session, and the token is the same gate that served the page. */
  surfaceToken?: string;
}) {
  const theme = epaper ? EPAPER_THEME(app.theme ?? null) : app.theme ?? null;
  const page = app.pages[0] ?? { slug: "", title: "", blocks: [] };
  const stats = (page.blocks ?? []).filter((b): b is Extract<AppBlock, { type: "stat" }> => b.type === "stat");
  const rest = (page.blocks ?? []).filter((b) => b.type !== "stat");
  return (
    <div className="min-h-screen" style={themeWrapperStyle(theme) ?? { background: "#f4f2ee" }}>
      <header className="px-6 py-4 flex items-center gap-3 border-b" style={{ borderColor: "var(--app-border, #e2e8f0)" }}>
        {theme?.logo ? (
          // EXTERNAL-IMAGE-OK: an app theme assetRef (data: URL or hosted URL, capped at 500KB),
          // never a core-files path. This page also holds no token, so an authed path could not
          // be resolved here anyway.
          <img src={theme.logo} alt="" className="h-7 w-7 rounded object-contain" />
        ) : null}
        <span className="font-extrabold text-lg">{app.name}</span>
        <div className="flex-1" />
        <span className="text-[10px] font-mono uppercase tracking-widest" style={mutedStyle(theme)}>public · read-only</span>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-5">
        {stats.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {stats.map((b, i) => (
              <StatBlock key={`stat-${i}`} block={b} data={data} theme={theme} />
            ))}
          </div>
        )}
        {rest.map((b, i) => {
          if (b.type === "markdown") {
            return (
              <div key={`b-${i}`} className="prose prose-sm max-w-none" style={proseStyle(theme)}>
                <ReactMarkdown>{b.body}</ReactMarkdown>
              </div>
            );
          }
          if (b.type === "view") return <ViewBlock key={`b-${i}`} block={b} data={data} theme={theme} />;
          if (b.type === "custom") {
            return (
              <CustomBlockFrame
                key={`b-${i}`}
                html={customSrcDoc(b.html, theme, data)}
                height={b.height ?? 420}
                surfaceToken={surfaceToken}
              />
            );
          }
          return null;
        })}
      </main>
    </div>
  );
}

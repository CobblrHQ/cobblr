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

import ReactMarkdown from "react-markdown";
import { EntityTile } from "@cobblr/platform-web";
import type { AppTheme, AppBlock, AppPage } from "../lib/api";
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
  const key = block.agg === "sum" && block.field ? `${block.view_id}:${block.field}` : block.view_id;
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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((i) => (
            <EntityTile key={`${i.kind}:${i.id}`} src={i.image_path} title={i.title} subtitle={i.subtitle ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PublicAppPlayer({ app, data }: { app: PublicAppPayload; data: PublicAppData }) {
  const theme = app.theme ?? null;
  const page = app.pages[0] ?? { slug: "", title: "", blocks: [] };
  const stats = (page.blocks ?? []).filter((b): b is Extract<AppBlock, { type: "stat" }> => b.type === "stat");
  const rest = (page.blocks ?? []).filter((b) => b.type !== "stat");
  return (
    <div className="min-h-screen" style={themeWrapperStyle(theme) ?? { background: "#f4f2ee" }}>
      <header className="px-6 py-4 flex items-center gap-3 border-b" style={{ borderColor: "var(--app-border, #e2e8f0)" }}>
        {theme?.logo ? (
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
              <iframe
                key={`b-${i}`}
                title="custom app"
                sandbox="allow-scripts"
                srcDoc={customSrcDoc(b.html, theme, data)}
                style={{ width: "100%", height: b.height ?? 420, border: "none" }}
              />
            );
          }
          return null;
        })}
      </main>
    </div>
  );
}

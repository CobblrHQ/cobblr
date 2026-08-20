import { ExternalLink } from "lucide-react";
import type { AiProviderDef } from "../lib/api";

type AiProviderSetup = NonNullable<AiProviderDef["setup"]>;

/** How to GET the credentials, shown above the fields that ask for them.
 *
 *  Both AI connection forms (workspace Configuration and personal Connections) used to
 *  render a provider as a dropdown entry plus a bare input, so the only place to explain
 *  "sign in, click Create API key, paste it here" was inside the field label. That gave
 *  one long parenthetical containing a URL as plain text, which somebody has to retype by
 *  hand. Retyping a URL is where a non-technical person stops.
 *
 *  So: numbered steps, real links, and the caveat separated from the instructions rather
 *  than buried at the end of one of them. Same component in both places, so the two
 *  surfaces cannot drift into telling people different things. */
export function ProviderSetupSteps({ setup }: { setup?: AiProviderSetup }) {
  if (!setup) return null;
  return (
    <div className="rounded border border-line dark:border-slate-700 bg-mortar/40 dark:bg-slate-800/40 p-3 text-sm">
      <p className="text-muted mb-2">{setup.summary}</p>
      <ol className="list-decimal ml-4 space-y-1.5">
        {setup.steps.map((s, i) => (
          <li key={i}>
            {s.href ? (
              // Deliberately loud. An underline alone did not read as clickable to the
              // person this whole panel is for: they saw instructions, not a door. So it
              // gets the app's link colour, an external-link icon, and a box that grows a
              // border on hover, which is three signals instead of one.
              <a
                href={s.href}
                target="_blank"
                // noreferrer alongside noopener: these are third-party sign-up pages, and
                // there is no reason to hand them the Cobblr URL a person came from.
                rel="noopener noreferrer"
                className="inline-flex items-baseline gap-1 text-accent font-medium underline underline-offset-2
                           rounded px-1 -mx-1 border border-transparent hover:border-accent/40 hover:bg-accent/5
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {s.text}
                <ExternalLink size={12} className="shrink-0 self-center" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              s.text
            )}
          </li>
        ))}
      </ol>
      {setup.caveat && (
        <p className="mt-2.5 pt-2.5 border-t border-line dark:border-slate-700 text-muted text-xs">
          {setup.caveat}
        </p>
      )}
    </div>
  );
}

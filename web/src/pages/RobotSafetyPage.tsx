import { productName, usePageTitle, WorkspaceLink } from "@cobblr/platform-web";
import { SAFETY_BOUNDARY } from "@cobblr/platform-contract/robot-safety-boundary";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
/** The safety boundary every arm and cell page links to: where safety
 *  lives, what Cobblr does and never does, and the guards that hold it. */
/** The boundary's words, in the name this instance goes by. */
const named = (text: string) => text.replace(/\bCobblr\b/g, productName());
export function RobotSafetyPage() {
 const { activeSlug: slug } = useActiveOrg();
 usePageTitle(named(SAFETY_BOUNDARY.title));
 return <div className="min-h-screen bg-surface text-content"><SkipToContent /><main id={MAIN_ID} data-testid="robot-safety" className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4">
  <header className="flex flex-wrap gap-3 items-center"><h1 className="flex-1 text-2xl font-semibold">{named(SAFETY_BOUNDARY.title)}</h1><WorkspaceLink className="min-h-11 rounded border border-line px-3 py-2" slug={slug} to="/machines">Back to machines</WorkspaceLink></header>
  <p className="text-lg">{named(SAFETY_BOUNDARY.summary)}</p>
  {SAFETY_BOUNDARY.sections.map(s => <section key={s.heading} className="space-y-1"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{s.heading}</h2><p>{named(s.body)}</p></section>)}
  <section className="space-y-2"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted">How it is held</h2>
   <ul className="list-disc pl-5 space-y-1">{SAFETY_BOUNDARY.guards.map(g => <li key={g.guard}>{named(g.guard)}.</li>)}</ul>
   <p className="text-sm text-muted">Each of these is checked by a test every time the software changes. A passing test is evidence about the software, never a safety validation: the integrator's risk assessment and the controller's safety configuration are the safety case.</p></section>
 </main></div>;
}
/** The link every arm and cell page carries to the boundary. */
export function SafetyBoundaryLink({ slug }: { slug: string }) {
 return <WorkspaceLink data-testid="safety-boundary-link" className="text-sm text-accent underline" slug={slug} to="/safety/robot-arms">{`${productName()} and safety: why ${productName()} is never part of a safety chain`}</WorkspaceLink>;
}

// Where a command the panel offers came from, said the way a person reads
// it. Three kinds share the offer bubble: one worked out from the page
// (`computed:`), one a module or Cobblr itself ships (`shipped:`), and one
// this workspace learned by watching an AI. The bubble used to say "taught
// from" for the shipped kind too, which a person reads as "this workspace
// learned it", and it did not (found walking #3159 on the rig, 2026-09-20).

export function commandOrigin(id: string, template: string): string {
  if (id.startsWith("computed:")) return "worked out from the page, no AI used";
  if (id.startsWith("shipped:")) return `built in: “${template}”`;
  return `taught from “${template}”`;
}

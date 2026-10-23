// Where a command the panel offers came from, said the way a person reads
// it. Three kinds share the offer bubble: one worked out from the page
// (`computed:`), one a module or Cobblr itself ships (`shipped:`), and one
// this workspace learned by watching an AI. The bubble used to say "taught
// from" for the shipped kind too, which a person reads as "this workspace
// learned it", and it did not (found walking #3159 on the rig, 2026-09-20).
//
// The template is shown as the shape of the sentence, its blanks as "…": a
// "{name}" under a confirm read as a place the card had failed to fill in
// (#7837). What will be made is said above it, in the person's words.

const shape = (template: string): string => template.replace(/\{[a-z0-9_]+\}/gi, "…");

export function commandOrigin(id: string, template: string): string {
  if (id.startsWith("computed:")) return "worked out from the page, no AI used";
  if (id.startsWith("shipped:")) return `built in: “${shape(template)}”`;
  return `taught from “${shape(template)}”`;
}

import { servedModelDiffers, servedModelText } from "@cobblr/platform-contract/ai-models";

/** A logged AI call's model: "gemini-3.5-flash → gemini-3.6-flash" when the
 *  provider answered with another model than the one asked for, else the
 *  model asked for. */
export function AiCallModel({ model, served }: { model: string | null | undefined; served?: string | null }) {
  if (!model && !served) return <>—</>;
  const differs = !!model && servedModelDiffers(model, served);
  return (
    <span
      data-served-model={served ?? undefined}
      title={differs ? `Asked for ${model}; the provider answered with ${served}.` : undefined}
    >
      {servedModelText(model, served)}
    </span>
  );
}

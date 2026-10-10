// The options of a model select for a provider that lists its models
// (#5417): each family's "latest" first, then the exact versions to pin. One
// copy for every picker that offers them: a workspace's job picker on the AI
// page and a person's own defaults per job (#5404).
import type { AiModelChoiceView } from "../lib/api";

export function ModelChoiceOptions({ choices, noteFor }: { choices: readonly AiModelChoiceView[]; noteFor?: (id: string) => string | null }) {
  // With a note to give (Quick look: "slow for a quick look"), the models
  // without one come first in each group.
  const ordered = noteFor ? [...choices].sort((a, b) => Number(!!noteFor(a.id)) - Number(!!noteFor(b.id))) : choices;
  const latest = ordered.filter((c) => c.latest);
  const pins = ordered.filter((c) => !c.latest);
  const label = (c: AiModelChoiceView) => (noteFor?.(c.id) ? `${c.label} (${noteFor(c.id)})` : c.label);
  return (
    <>
      {latest.length > 0 && (
        <optgroup label="Latest (moves to each new version)">
          {latest.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </optgroup>
      )}
      {pins.length > 0 && (
        <optgroup label="Pin a version">
          {pins.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

// How long to keep a sandbox: the person picks from the bounded set and
// nothing else (#3254). Three radios from the contract, so this and the
// server's refusal of any other number are one rule.
import { TRIAL_LENGTHS, TRIAL_LENGTH_LABELS, type TrialLengthDays } from "@cobblr/platform-contract/trial-length";

export function TrialLengthPicker({ value, onChange, disabled }: { value: TrialLengthDays; onChange: (d: TrialLengthDays) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="How long to keep it" className="grid grid-cols-3 gap-2">
      {TRIAL_LENGTHS.map((d) => {
        const on = d === value;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(d)}
            className={
              "rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-50 " +
              (on
                ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 text-content dark:text-mortar-100"
                : "border-line dark:border-slate-600 text-muted hover:border-cobble-300 dark:hover:border-cobble-700")
            }
          >
            {TRIAL_LENGTH_LABELS[d]}
          </button>
        );
      })}
    </div>
  );
}

/** "a week", "two weeks", "a month": the label in a sentence. */
export function trialLengthPhrase(days: TrialLengthDays): string {
  return TRIAL_LENGTH_LABELS[days].toLowerCase();
}

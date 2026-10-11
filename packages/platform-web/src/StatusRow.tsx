// A row or card that changes with a state (offered / on, not connected /
// connected, on / turned off), with the links a person needs in every state
// written once.
//
// Each card used to draw one JSX branch per state, and a link that belonged to
// all of them lived in one branch only: the bell's push row lost Settings the
// moment notifications were turned on, a minted token lost the link to manage
// tokens, a turned-off label lost Rename (#5774). Here a state chooses only
// its own content; `always` is drawn once, outside the choice, so no state can
// drop it. `lint:status-rows-keep-their-links` sends a card that draws its own
// row per state here.
import type { ReactNode } from "react";

export interface StatusRowProps<S extends string> {
  /** The state the row is in now; also its `data-state`, for tests and walks. */
  state: S;
  /** What each state shows: its words and the one action it offers. */
  states: Record<S, ReactNode>;
  /** What every state shows: Settings, Send a test, Details, Rename. */
  always?: ReactNode;
  /** A last control after everything else, such as a dismiss ×. */
  end?: ReactNode;
  /** The shell's classes; a row's layout is the caller's. */
  className?: string;
  testId?: string;
}

export function StatusRow<S extends string>({ state, states, always, end, className, testId }: StatusRowProps<S>) {
  return (
    <div className={className} data-testid={testId} data-state={state} data-status-row="">
      {states[state]}
      {always != null && always !== false && (
        <span className="contents" data-status-always="">
          {always}
        </span>
      )}
      {end}
    </div>
  );
}

// Tips: one short suggestion at a time, where the person already is.
//
// A tip is a condition (a fact about this device or about what the person has
// done) and a door (a line of text, an action that opens a sheet). The app and
// any module register tips; `pickTip` decides which one, if any, shows:
//
// - one tip at a time, the highest priority that applies;
// - at most one NEW tip a day: a tip first shown today blocks any other tip
//   that has never been shown, while a tip already introduced keeps its place;
// - a dismissal is final for that tip.
//
// What a person has been shown and has dismissed lives on their ACCOUNT
// (users.tips), so a second device or a cleared browser does not bring a
// dismissed tip back. A tip about the DEVICE ("install the app": installed-ness
// is per phone) keeps its dismissal on the device instead, via its own hooks.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Lightbulb, X } from "lucide-react";
import { dayHere } from "@cobblr/platform-contract/day";
import { Modal } from "./Modal";

/** What the account says about tips: tip id → ISO time. */
export interface TipState {
  shown?: Record<string, string>;
  dismissed?: Record<string, string>;
}

export interface Tip {
  /** Stable, lowercase: `install-app`, `<module>:<name>`. */
  id: string;
  /** Higher shows first when several apply. */
  priority: number;
  /** Whether it applies to this person, on this device, right now. */
  applies: () => boolean;
  /** The one line. */
  text: string;
  /** The button that opens `body`. */
  actionLabel: string;
  /** The sheet the action opens. `close` ends it; `dismiss` also retires the tip. */
  body: (h: { close: () => void; dismiss: () => void }) => ReactNode;
  /** A tip about the device keeps its dismissal there. Both or neither. */
  device?: { dismissed: () => boolean; dismiss: () => void };
}

const registry = new Map<string, Tip>();

/** Add a tip. Registering the same id again replaces it. */
export function registerTip(tip: Tip): void {
  registry.set(tip.id, tip);
}

export function registeredTips(): Tip[] {
  return [...registry.values()];
}

function dismissed(tip: Tip, state: TipState): boolean {
  return tip.device ? tip.device.dismissed() : !!state.dismissed?.[tip.id];
}

/** The one tip to show now, or null. */
export function pickTip(tips: Tip[], state: TipState, now: Date = new Date()): Tip | null {
  const today = dayHere(now);
  const shown = state.shown ?? {};
  const newToday = Object.values(shown).some((at) => dayHere(new Date(at)) === today);
  const open = tips.filter((t) => !dismissed(t, state) && t.applies()).sort((a, b) => b.priority - a.priority);
  return open.find((t) => shown[t.id] || !newToday) ?? null;
}

export interface TipStripProps {
  state: TipState;
  /** Record that a tip was shown (the account keeps the first time only). */
  onShown: (id: string) => void;
  /** A tip was dismissed. `person`: record it on the account. `device`: the
   *  tip already kept it on this device; only redraw. */
  onDismiss: (id: string, where: "person" | "device") => void;
  /** Defaults to every registered tip. */
  tips?: Tip[];
  now?: Date;
}

/** The tip line for a message strip: nothing when no tip applies. */
export function TipLine({ state, onShown, onDismiss, tips, now }: TipStripProps) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<string | null>(null);
  const tip = pickTip((tips ?? registeredTips()).filter((t) => t.id !== gone), state, now);
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (tip && !state.shown?.[tip.id] && told.current !== tip.id) {
      told.current = tip.id;
      onShown(tip.id);
    }
  }, [tip, state.shown, onShown]);
  if (!tip) return null;
  const dismiss = () => {
    if (tip.device) tip.device.dismiss();
    onDismiss(tip.id, tip.device ? "device" : "person");
    setGone(tip.id);
    setOpen(false);
  };
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="tip-line" data-tip={tip.id}>
      <Lightbulb size={13} className="text-accent shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-200">{tip.text}</span>
      <button type="button" onClick={() => setOpen(true)} className="shrink-0 text-accent hover:underline font-medium">
        {tip.actionLabel}
      </button>
      <button type="button" onClick={dismiss} className="shrink-0 text-faint hover:text-content" title="Dismiss this tip" aria-label="Dismiss this tip">
        <X size={13} />
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} size="sm">
          {tip.body({ close: () => setOpen(false), dismiss })}
        </Modal>
      )}
    </div>
  );
}

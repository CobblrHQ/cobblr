/** core-queue v0.1: persistent background work for modules.
 *  enqueue() defers a unit of work; registerWorker(name, fn) sets
 *  the handler that the api process's worker loop will invoke when
 *  the job's run_at has arrived. See api/src/platform/queue.ts. */
/** One thing a person can do about a notification, straight from the message. */
/** One line of a notification card and the actions that are about it. */
export interface NotificationCardRow {
  /** The line, plain text with light markdown (bold), e.g. "**Milk** — expires today". */
  text: string;
  /** Set when reading the inbox, never at dispatch: the question this line's
   *  buttons asked has been answered, and how. Its buttons are gone. */
  settled?: { label: string; at: string | null };
  /** Ids from the notification's `actions`, in the order to offer them. The
   *  first is the one a channel puts beside the line when it can hold only one. */
  actions?: string[];
}

export interface NotificationAction {
  /** Stable within one notification; this is what a client sends back. */
  id: string;
  label: string;
  /** The label when the button sits beside the line it is about (a card
   *  row), where the item's name is already on the line: "Used up" rather
   *  than "Used up · Baby Carrots". Falls back to `label`. */
  short?: string;
  /** A registered action id, e.g. "purchases:mark-arrived". Prefer an
   *  IDEMPOTENT action: a card can be pressed twice, from two devices, or
   *  long after the fact. */
  action: string;
  args?: Record<string, unknown>;
  /** A hint. Channels with no notion of emphasis ignore it. */
  style?: "primary" | "secondary" | "danger";
}

/**
 * WHERE A NOTIFICATION TAKES YOU — required, one way or the other.
 *
 * A notification is a thing that happened somewhere. Telling somebody about it
 * and then leaving them to find it is the failure this type exists to prevent:
 * five shipped notifications ("you hit your goal", "milk expires today",
 * "service is due") had no link at all, so the row was a dead sentence and the
 * only route to the thing was to remember where it lived (audit, 2026-09-06).
 *
 * A lint could only ever flag a link that is too SHALLOW, never one that is
 * absent, because nothing distinguishes "no link" from "not written yet". So
 * the destination is required by the TYPE, and a notification that genuinely
 * has nowhere to go says why in one line instead of being silent about it.
 */
export type NotificationDestination =
  | {
      /** Where the thing IS. Relative to the workspace ("/inventory/parts/123");
       *  the platform makes it absolute per channel. */
      link_url: string;
      no_link_reason?: never;
    }
  | {
      link_url?: never;
      /** Why this one has nowhere to go — a fact with no page behind it, a
       *  workspace-wide announcement. Not a TODO: if a destination exists, link
       *  it. Written down so the next reader knows it was decided, not
       *  forgotten. */
      no_link_reason: string;
    };

/** What a notification that comes from the calendar is ABOUT: one record and
 *  the question being put about it. Two producers that raise the same subject
 *  on the same day (a receipt's sweep and its purchase order's, say) are one
 *  notification, however many sweeps noticed it.
 *
 *  `kind` is an entity kind id ("purchases:order") or, for a thing that is not
 *  a record, the producer's own namespaced name; `question` is the same
 *  vocabulary across producers ("delivery-due", "expiring", "service-due"). */
export interface AttentionSubject {
  kind: string;
  id: string;
  question: string;
  /** The line that says it, in the producer's words: the card row's text when
   *  the notice has a card of rows, else the sentence. When a notice overlaps
   *  what a person was already told today, the notifier says only the lines of
   *  the subjects that are new. */
  line: string;
}

/**
 * What CAUSED this: somebody doing something (`activity`, the default), or a
 * date arriving (`schedule`).
 *
 * A second dial beside priority, answering a different question. Priority is
 * "how much does this interrupt". This is "was it news, or was it the
 * calendar" — and people want those on different cadences on the SAME
 * channel: chat as it happens, everything due today as one morning list.
 * Priority cannot express that, because both are `normal`.
 *
 * Pass `schedule` when the notification exists because a date or threshold
 * was reached and was knowable in advance: expiring today, service due,
 * running low. Leave it alone for anything that just happened.
 *
 * `lint:dated-notifications` fails the build on a dispatch that carries a
 * dated payload and does not say which it is, because getting it wrong is
 * silent and backwards: a "milk expires today" that forgot to declare
 * itself interrupts at 03:00 when the sweep happened to run.
 */
/** A notification raised by a date arriving names what it is about; one raised
 *  by somebody doing something need not. A type, not a lint: a scheduled
 *  dispatch with no subject does not compile, so no producer can skip it. */
/** `subjectDay` is the day (YYYY-MM-DD) the subject is about, by the clock the
 *  producer ran on: a sweep walked on a given `now` passes that day, so a
 *  heads-up two days out and the day-of line are two notices, not one. Defaults
 *  to the day that has arrived everywhere. */
export type AttentionDeclaration =
  | { triggeredBy: "schedule"; subjects: AttentionSubject[]; subjectDay?: string }
  | { triggeredBy?: "activity"; subjects?: AttentionSubject[]; subjectDay?: string };

export interface DigestContribution { key: string; text: string; link?: string }
export type DigestContributor = (orgId: string, db: unknown) => Promise<DigestContribution[]>;
/** How a question a notification's button asked was answered: "Done", "Snoozed until Nov 5". */
export interface ActionSettlement { label: string; at: string | null }
export interface PlatformNotifications {
  /** The buttons that run these actions ask a question a record can later answer
   *  (an overdue service, done elsewhere). `settle` gets the arguments each
   *  button carries and says which are already answered (null: still open).
   *  Read when the inbox is read, so a reload, another tab and the
   *  Maintenance page all agree; an answered button is not offered again. */
  registerActionSettlement(actionIds: readonly string[], settle: (orgId: string, args: Array<Record<string, unknown>>) => Promise<Array<ActionSettlement | null>>): void;
  /** Adds a module's current needs to an existing digest, only while that module is enabled. */
  registerDigestContributor(eventType: string, module: string, read: DigestContributor): void;
  digestContributions(eventType: string, orgId: string, db: unknown): Promise<DigestContribution[]>;
  /** Fan a notification to one user across their enabled channels.
   *  Writes the row, looks up the user's per-event-type channel
   *  preferences, and delivers via every enabled channel. */
  dispatch(p: NotificationDestination & AttentionDeclaration & {
    idempotencyKey?: string;
    orgId: string;
    userId: string;
    eventType: string;
    message: string;
    module?: string;
    entityType?: string;
    entityId?: string;
    payload?: unknown;
    /**
     * The substance behind the one-line message, for a channel that can render
     * more than a sentence (a Discord DM becomes a card; the bell and email are
     * unaffected).
     *
     * Optional on purpose: a channel that cannot render it MUST still deliver,
     * so `message` has to stand alone and `link_url` reaches the same place.
     * Pass PLAIN TEXT — a body with entity tokens still in it will show a uuid
     * to whoever reads the notification.
     *
     * `rows` is the body as LINES, each naming the actions (by their id in
     * `actions`) that are about that line, for a channel that can put a
     * button beside the line it answers: a Discord DM lays each row out as a
     * section with its button as the accessory, and the in-app card renders
     * each row with its own buttons. A digest of fifteen groceries used to
     * arrive as a list and then fifteen buttons in a block beneath it, each
     * repeating the name so it could be matched back to its line (#3282).
     * `body` still stands alone for a channel that cannot pair them.
     */
    card?: { heading?: string; body?: string; context?: string; rows?: NotificationCardRow[] };
    /**
     * The message or card carries a person's private content: a personal
     * document, a secret field (#5243). A push to their phone or computer then
     * shows a generic line and the link, never the words, because a lock
     * screen is not private. The bell and the record still show it to them.
     */
    private?: boolean;
    /**
     * How urgent this is. Defaults to `normal`.
     *
     * It decides two separate things, and a module only has to think about the
     * second one: whether a channel hears about it at all (each subscription
     * carries a min_priority), and whether a channel with a DELIVERY WINDOW set
     * batches it into a digest or interrupts immediately. At or below `normal`
     * waits for the window; `high` and `urgent` do not.
     *
     * The dispatcher has always taken a priority; the module-facing contract did
     * not expose it, so every module notification was `normal` by omission. That
     * made the batching rule unable to see the difference it exists to make -
     * "your ice cream is in a cupboard" and "you are low on cumin" would have
     * arrived in the same morning digest.
     *
     * Reserve `high` for facts that stop being useful if they wait. A prediction
     * about shopping is not one.
     */
    priority?: "low" | "normal" | "high" | "urgent";
    /** What the reader can DO about it, offered inside the message itself.
     *
     *  Channel-agnostic on purpose: a channel that can render them does
     *  (Discord as buttons), one that cannot delivers the message and its link
     *  unchanged. So `message` must still stand alone and must never say
     *  "press the button below".
     *
     *  Stored on the notification row. A press arrives from a client carrying
     *  only an id, and the action it maps to is read back from the row — so
     *  `action` and `args` here are the server's copy, never the wire's. */
    actions?: NotificationAction[];
  }): Promise<{ notificationId: string; deliveredVia: string[] }>;
  /** Convenience: every member of an org. Modules that want to
   *  broadcast a notification (e.g. "this task is now unblocked")
   *  iterate this and dispatch per-user. Prefer `audienceFor` for a
   *  workspace-wide kind: the dispatcher drops anyone outside the kind's
   *  audience anyway, so iterating everyone only composes messages that are
   *  then thrown away. */
  orgMemberIds(orgId: string): Promise<string[]>;
  /** The people a KIND of notification is for in this workspace, per the
   *  workspace's own setting (everyone by default, the owners, or a chosen
   *  few), intersected with live membership. What a sweep should iterate. */
  audienceFor(orgId: string, eventType: string): Promise<string[]>;
  /** The workspace's display name. Exists because a module has no other way to
   *  say WHERE something happened: the discussion room's notifications read
   *  "mentioned you in your workspace" from the action door, which is honest
   *  and worse than the name. Beside orgMemberIds for the same reason that
   *  lives here — workspace identity a notification needs, behind the contract
   *  instead of a meta read isolation forbids. Null when the org is gone. */
  orgName(orgId: string): Promise<string | null>;
}

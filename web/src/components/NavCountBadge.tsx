// The pill that carries a nav row's live number. Same visual as the bell's
// unread badge, laid inline so it sits after a label in a row or a chip
// rather than floating over an icon. Renders nothing at zero: an empty pill
// would read as "something is here" when nothing is.

export function NavCountBadge({
  count,
  label,
  className = "",
}: {
  count: number | undefined;
  /** What the number counts, for assistive tech ("3 waiting in Scan Inbox"). */
  label: string;
  className?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-nav-badge={count}
      aria-label={`${count} waiting in ${label}`}
      className={
        "inline-flex items-center justify-center shrink-0 min-w-[16px] h-[16px] px-1 rounded-full " +
        "bg-ember-500 text-mortar-50 text-[9px] font-bold leading-none " +
        className
      }
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

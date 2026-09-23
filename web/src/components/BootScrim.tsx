// The app before it has anything to show: auth still bootstrapping, or a
// full-document redirect on its way out. The testid is the seam e2e/shot-guard
// waits on — a screenshot taken here is a centred grey ellipsis on an empty
// page, which looks like a capture and is worth nothing. Seven of them shipped
// with the docs on 2026-09-22 (#3396).
export function BootScrim() {
  return (
    <div
      data-testid="app-boot-scrim"
      className="min-h-full flex items-center justify-center text-faint font-mono text-xs"
    >
      …
    </div>
  );
}

// Where the scan camera is filing: the area you are standing in, or the
// container a scanned QR armed. Self-contained, so it sits in the top bar or
// the bottom-left slot with one line (#6438). It takes the room it is given
// and wraps a long name onto a second line rather than cutting it short: the
// owner could not read which area was set.
import { MapPin, Package, X } from "lucide-react";

export function ScanAreaChip({
  areaName,
  containerName,
  onSetArea,
  onClearContainer,
}: {
  areaName: string | null;
  /** Set while a scanned container is armed: every scan files into it. */
  containerName: string | null | false;
  onSetArea: () => void;
  onClearContainer: () => void;
}) {
  if (containerName !== false)
    return (
      <button
        type="button"
        onClick={onClearContainer}
        title="Scanning into this container - tap to clear"
        className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-cobble-600/85 px-3 py-1.5 text-left text-xs text-white hover:bg-cobble-600"
      >
        <Package size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 break-words leading-tight">Into {containerName ?? "container"}</span>
        <X size={12} className="shrink-0 text-white/70" />
      </button>
    );
  return (
    <button
      type="button"
      onClick={onSetArea}
      className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-left text-xs text-white hover:bg-black/70"
    >
      <MapPin size={13} className={`shrink-0 ${areaName ? "text-emerald-400" : "text-white/60"}`} />
      <span className="min-w-0 flex-1 break-words leading-tight">{areaName ?? "Set area"}</span>
    </button>
  );
}

// "Email receipts to <address>" — one chip, everywhere it appears.
//
// The receipt drop-box address is a genuine intake channel, and a feature nobody
// can find is a feature that does not exist (interface-principles #2), so it
// earns a visible affordance that reveals and copies in one press rather than a
// permanent wall of address text eating a row.
//
// It lives HERE rather than inline because it appears on more than one page:
// the scan inbox header and the Purchases header. Two inline copies of a chip
// plus its menu is how the same fact ends up rendered two different ways - the
// drift this session has been un-picking in category normalizers and location
// labels. One component, one behaviour, both pages.

import { Mail } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { HeaderMenu, MenuHead } from "./HeaderMenu";

export function ReceiptAddressChip({
  address,
  /** Extra classes for the trigger's host (e.g. hiding it on a phone). */
  className,
  /** Show the word "Email receipts" from this breakpoint up. The scan header is
   *  tight enough to need `lg`; a roomier header can afford `sm`. */
  labelFrom = "lg",
}: {
  address: string;
  className?: string;
  labelFrom?: "sm" | "md" | "lg";
}) {
  const toast = useToast();
  // Tailwind needs whole class names, not interpolated fragments.
  const labelClass =
    labelFrom === "sm" ? "hidden sm:inline" : labelFrom === "md" ? "hidden md:inline" : "hidden lg:inline";
  return (
    <HeaderMenu
      width={280}
      align="right"
      className={className}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title="Forward a receipt to this address and its lines become items"
          className="inline-flex items-center gap-1.5 rounded-full border border-line dark:border-slate-700 px-2.5 py-1 text-[11.5px] text-muted dark:text-slate-400 hover:border-accent hover:text-content transition shrink-0"
        >
          <Mail size={12} />
          <span className={labelClass}>Email receipts</span>
        </button>
      )}
    >
      {() => (
        <>
          <MenuHead>Email receipts to</MenuHead>
          <div className="px-3 pb-2">
            <code className="block overflow-x-auto whitespace-nowrap rounded bg-mortar-100 dark:bg-slate-800 px-1.5 py-1 text-[11px] text-content dark:text-mortar-100 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {address}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                toast.success("Address copied");
              }}
              className="mt-1.5 w-full rounded bg-cobble-600 hover:bg-cobble-700 px-2 py-1 text-[11px] font-medium text-white transition"
            >
              Copy address
            </button>
          </div>
        </>
      )}
    </HeaderMenu>
  );
}

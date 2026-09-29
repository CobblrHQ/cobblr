// Every search box in the app, one of them. A × on the far right empties it
// whenever it has text, Esc does the same, and the cursor stays in the box so
// the next search is typed straight away (#4014). A box that is already empty
// lets Esc through, so a sheet or a palette around it still closes on Esc.
//
// Search boxes were written by hand, twenty-odd of them, each with its own
// height, icon and padding, and none could be emptied without selecting the
// text. lint:capabilities (search:one-search-input) refuses a new hand-written
// one outside this file.
import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { Loader2, Search, X } from "lucide-react";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** After × or Esc emptied it (a list that also resets a page, say). */
  onClear?: () => void;
  /** "md" is the header strip's control height (36px); "sm" a denser 32px
   *  for pickers and rails; "lg" 40px, a phone's thumb-sized box. */
  size?: "sm" | "md" | "lg";
  /** "onDark" over a photo or a dark sheet (the image zoom's search). */
  tone?: "default" | "onDark";
  /** Classes for the wrapper (width, flex behaviour); the box fills it. */
  wrapperClassName?: string;
  /** A lookup behind the box is running (a typeahead): a quiet spinner. */
  busy?: boolean;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, onClear, size = "md", tone = "default", wrapperClassName = "", className = "", onKeyDown, busy = false, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement, []);
  const clear = () => {
    onChange("");
    onClear?.();
    inner.current?.focus();
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && value) {
      // Empty the box; do not also close what it sits in.
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
    onKeyDown?.(e);
  };
  const h = size === "sm" ? "h-8 text-[13px]" : size === "lg" ? "h-10 text-sm" : "h-9 text-sm";
  const skin =
    tone === "onDark"
      ? // Over a photo in either theme: the same in dark mode, said so.
        "border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:border-white/40 dark:border-white/20 dark:bg-white/10 dark:text-white"
      : "border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100 placeholder:text-faint focus:border-accent";
  return (
    <div className={`relative flex items-center ${wrapperClassName}`} data-search-input>
      <Search size={14} aria-hidden className={`pointer-events-none absolute left-2.5 ${tone === "onDark" ? "text-white/50" : "text-faint dark:text-slate-500"}`} />
      <input
        ref={inner}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keyDown}
        className={`${h} w-full min-w-0 rounded-md border pl-8 pr-8 focus:outline-none [&::-webkit-search-cancel-button]:hidden ${skin} ${className}`}
        {...rest}
      />
      {busy && <Loader2 size={13} aria-label="Looking" className={`absolute ${value ? "right-8" : "right-2.5"} animate-spin text-faint`} />}
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear (Esc)"
          // Keep the box focused through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          className={`absolute right-1.5 grid h-6 w-6 place-items-center rounded ${tone === "onDark" ? "text-white/60 hover:text-white hover:bg-white/10" : "text-faint hover:text-content hover:bg-subtle dark:hover:bg-slate-800"}`}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
});

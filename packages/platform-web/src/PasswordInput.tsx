// A password (or key) field whose owner can see what they typed.
//
// Every password field on the platform goes through this one component
// (lint:raw-password-input refuses a raw type="password"), so the eye works the
// same way everywhere: on sign-up, sign-in, keeping a sandbox, a reset, account
// settings, and the keys and tokens a connection asks for.
//
// What it keeps while toggling: the browser's autocomplete hint (new-password /
// current-password, passed through), the focus (the button does not take it),
// and the caret, which a type change otherwise throws to the end in some
// browsers. The button sits inside the field's right edge, absolutely placed,
// so the field is the same size shown or hidden, and its tap target is 44px.
import { forwardRef, useRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Classes for the wrapper (a flex child's `flex-1`, a width). */
  wrapperClassName?: string;
  /** What the field holds, for the button's label: "Show password" by default,
   *  "Show API key" for a key. */
  what?: string;
  /** Start shown: a key being pasted in once, where seeing it is the point
   *  (the AI connection forms). */
  defaultShown?: boolean;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { className, wrapperClassName, what = "password", defaultShown = false, ...rest },
  ref,
) {
  const [shown, setShown] = useState(defaultShown);
  const inner = useRef<HTMLInputElement | null>(null);

  return (
    <div className={"relative " + (wrapperClassName ?? "")}>
      <input
        {...rest}
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        type={shown ? "text" : "password"}
        // Shown text must not be "corrected" or capitalised on a phone.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={(className ?? "input") + " pr-11"}
      />
      <button
        type="button"
        aria-label={`${shown ? "Hide" : "Show"} ${what}`}
        aria-pressed={shown}
        // Keep the focus (and the phone's keyboard) in the field.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const next = !shown;
          const el = inner.current;
          // Changed here, and the caret put back twice: at once, and again on
          // the next frame, because Chromium moves the caret to the start of
          // the field a moment AFTER a type change (measured: the restore in
          // the same step, and one from a layout effect, were both undone).
          // React then renders the type it already has, and changes nothing.
          if (el) {
            const [start, end] = [el.selectionStart, el.selectionEnd];
            el.type = next ? "text" : "password";
            if (start !== null && document.activeElement === el) {
              el.setSelectionRange(start, end);
              requestAnimationFrame(() => {
                if (document.activeElement === el) el.setSelectionRange(start, end);
              });
            }
          }
          setShown(next);
        }}
        className="absolute right-0 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center text-faint hover:text-content dark:hover:text-mortar-100"
      >
        {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </div>
  );
});

/** A field that is a secret only sometimes (a connection's settings, where the
 *  definition says which): a PasswordInput when it is, a text input when not. */
export const SecretInput = forwardRef<HTMLInputElement, PasswordInputProps & { secret?: boolean }>(function SecretInput(
  { secret, what, defaultShown, wrapperClassName, ...rest },
  ref,
) {
  if (secret) return <PasswordInput ref={ref} what={what} defaultShown={defaultShown} wrapperClassName={wrapperClassName} {...rest} />;
  return <input ref={ref} type="text" {...rest} />;
});

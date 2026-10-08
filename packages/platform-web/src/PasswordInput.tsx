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
import React, { forwardRef, useRef, useState, type InputHTMLAttributes } from "react";
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

/** The attributes that tell a browser and the password managers this field is
 *  not part of a login: nothing to save, nothing to fill. Chrome reads a text
 *  field above a type="password" field as username + password and filled the
 *  owner's email into "Part-DB address" and his saved password into "API
 *  token" (#3903). `autoComplete="off"` alone is ignored for that pairing, so
 *  the field is never type="password" at all, and each manager is opted out by
 *  its own attribute. */
export const NOT_A_LOGIN = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** A key, a token, a webhook secret or a device's own password: something the
 *  person pastes in, never their Cobblr password. Masked with the same eye as
 *  PasswordInput, but by CSS (`-webkit-text-security`) on a plain text field,
 *  so no browser offers or saves a login for it. `secret={false}` is a plain
 *  field with the same opt-outs (a connection's non-secret settings).
 *
 *  The account's own password (sign-in, sign-up, a reset) is PasswordInput,
 *  where a manager SHOULD help; lint:raw-password-input keeps the two apart. */
export const SecretInput = forwardRef<HTMLInputElement, PasswordInputProps & { secret?: boolean }>(function SecretInput(
  { secret = false, what = "value", defaultShown = false, wrapperClassName, className, name, style, ...rest },
  ref,
) {
  const [shown, setShown] = useState(defaultShown);
  // A name a manager does not read as "password" / "email" / "username".
  const safeName = name && !/pass|user|email|login/i.test(name) ? name : `cobblr-secret-${what.replace(/\W+/g, "-")}`;
  const field = (
    <input
      {...rest}
      {...NOT_A_LOGIN}
      ref={ref}
      type="text"
      name={safeName}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      style={secret && !shown ? { ...style, WebkitTextSecurity: "disc" } as React.CSSProperties : style}
      className={(className ?? "input") + (secret ? " pr-11" : "")}
    />
  );
  if (!secret) return field;
  return (
    <div data-secret-field="" className={"relative " + (wrapperClassName ?? "")}>
      {field}
      <button
        type="button"
        aria-label={`${shown ? "Hide" : "Show"} ${what}`}
        aria-pressed={shown}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((v) => !v)}
        className="absolute right-0 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center text-faint hover:text-content dark:hover:text-mortar-100"
      >
        {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </div>
  );
});

/** The address of a server a connection talks to ("https://parts.local").
 *  A URL field, with the same opt-outs as a secret, so a browser never reads
 *  it as the username half of a login and fills an email into it (#3903). */
export const AddressInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { placeholder: string }>(
  function AddressInput({ name, ...rest }, ref) {
    return (
      <input
        {...rest}
        {...NOT_A_LOGIN}
        ref={ref}
        type="url"
        inputMode="url"
        name={name && !/user|email|login/i.test(name) ? name : "cobblr-server-address"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    );
  },
);

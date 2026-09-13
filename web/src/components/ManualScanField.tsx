// The typed door beside the camera: "Barcode number, or paste a Cobblr QR
// link". It decides nothing itself; typedVerdict (lib/scanPayload.ts) says
// what the text is, the same rule the camera applies to a decoded value, and
// the page does with a Cobblr label exactly what it does when the lens reads
// one. Words and web links are refused here with a sentence and never reach
// the inbox (the 2026-09-13 review pasted a location label URL and got a
// pending item named "Cobblr", #2850).
import { useState } from "react";
import { ScanLine } from "lucide-react";
import { TYPED_FIELD_HINT, TYPED_FIELD_PLACEHOLDER, typedVerdict } from "../lib/scanPayload";

export function ManualScanField({
  onLookup,
  onCobblrQr,
  className,
}: {
  /** A code to look up: the result modal, as a decoded barcode would. */
  onLookup: (code: string) => void;
  /** A Cobblr label: route to the place or record it names, as the camera would. */
  onCobblrQr: (token: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = typedVerdict(value);
        switch (v.action) {
          case "route-qr":
            setValue("");
            setRefusal(null);
            onCobblrQr(v.token);
            return;
          case "lookup":
            setValue("");
            setRefusal(null);
            onLookup(v.code);
            return;
          case "refuse":
            // The text stays, so it can be fixed rather than retyped.
            setRefusal(v.sentence);
            return;
          case "nothing":
            return;
        }
      }}
      className={className}
    >
      <div className="flex gap-2 items-center bg-black/55 rounded-full px-3 py-2 max-w-md mx-auto">
        <ScanLine size={16} className="text-white/60 shrink-0" />
        <input
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (refusal) setRefusal(null);
          }}
          placeholder={TYPED_FIELD_PLACEHOLDER}
          aria-label={TYPED_FIELD_HINT}
          title={TYPED_FIELD_HINT}
          aria-invalid={refusal ? true : undefined}
          className="flex-1 min-w-0 bg-transparent text-white placeholder-white/50 text-sm font-mono px-1 py-0.5 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-full bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1 text-sm font-medium disabled:opacity-50 shrink-0"
        >
          Scan
        </button>
      </div>
      {refusal && (
        <p role="alert" className="max-w-md mx-auto mt-1 px-4 text-xs text-amber-200">
          {refusal}
        </p>
      )}
    </form>
  );
}

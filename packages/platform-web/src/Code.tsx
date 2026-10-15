// A code, shown as one: a barcode, an id, a hex, a token's prefix, a route.
// The one place the code font is spelled (lint:code-font-only-for-codes), so
// it says "this is a code" and nothing else wears it: a time, a count or a
// sentence in the code font read as a log line (#6564: "8h ago" on the
// dashboard's Recent activity).
import type { HTMLAttributes, ReactNode } from "react";

export function Code({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <code className={"font-mono " + className} {...rest}>
      {children}
    </code>
  );
}

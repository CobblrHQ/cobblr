// JsonField as the app imports it: the field and its schema validator (ajv,
// about 30 KB gzipped) load when a form that has one is drawn, not with the
// package on every first page load (#4945). The field itself, and
// evaluateJson for code that wants the check without the input, are in
// ./JsonField (`@cobblr/platform-web/json-field`).

import { lazy, Suspense } from "react";
import type { JsonFieldProps } from "./JsonField";

const Field = lazy(() => import("./JsonField").then((m) => ({ default: m.JsonField })));

export function JsonField(props: JsonFieldProps) {
  return (
    // The field's own height while it loads, so the form does not jump.
    <Suspense fallback={<div className={props.className} style={{ minHeight: `${(props.rows ?? 8) * 1.25 + 2}rem` }} aria-busy="true" />}>
      <Field {...props} />
    </Suspense>
  );
}

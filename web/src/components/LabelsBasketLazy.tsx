// The labels basket, fetched only by a workspace that has labels on and only
// where one is drawn. Importing it from "@cobblr/labels/ui" directly pulled the
// whole labels UI (its pages, the QR library) into every first page load
// (#4945); this is the one door the shell uses.
import { lazy, Suspense, type ComponentProps } from "react";

const Basket = lazy(() => import("@cobblr/labels/ui").then((m) => ({ default: m.LabelsBasket })));

export function LabelsBasket(props: ComponentProps<typeof Basket>) {
  return (
    <Suspense fallback={null}>
      <Basket {...props} />
    </Suspense>
  );
}

// A dialog or sheet whose code loads the first time it opens.
//
// The shell mounts a lot of these on every page (members, the module picker,
// the spreadsheet import, the image search) and almost none of them open on a
// given visit, yet each one's code was part of every first page load (#4945).
// This draws nothing and loads nothing until `open` is first true, then keeps
// the component mounted, so it closes and reopens as it always did (its own
// state, its own close animation). `preload()` fetches the code early, for a
// hover or a press that is about to open it.

import { lazy, Suspense, useState, type ComponentProps, type ComponentType } from "react";

export function lazyOverlay<C extends ComponentType<any>>(
  load: () => Promise<{ default: C }>,
): ComponentType<ComponentProps<C> & { open: boolean }> & { preload: () => void } {
  type P = ComponentProps<C> & { open: boolean };
  const Inner = lazy(load) as unknown as ComponentType<P>;
  function LazyOverlay(props: P) {
    const [opened, setOpened] = useState(props.open);
    if (props.open && !opened) setOpened(true);
    if (!opened) return null;
    return (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    );
  }
  return Object.assign(LazyOverlay, { preload: () => void load() });
}

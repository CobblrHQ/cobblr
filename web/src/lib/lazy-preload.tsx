// A lazy component that, once its code is in, draws at once (#6563).
//
// React.lazy suspends on its first render even when the code has already
// loaded: the dashboard's "What do you want to do?" panel showed its 18rem
// placeholder for a frame and then grew to its real height, pushing the page
// down 600 px under the reader. Preloaded with `.preload()`, this renders the
// loaded component directly, never through the placeholder.
import { lazy, Suspense, type ComponentProps, type ComponentType, type ReactElement } from "react";

// `any` props: the same bound React.lazy takes, so a component of any props fits.
export function lazyWithPreload<C extends ComponentType<any>>(factory: () => Promise<{ default: C }>): ComponentType<ComponentProps<C>> & { preload: () => Promise<unknown> } {
  let loaded: C | null = null;
  let pending: Promise<{ default: C }> | null = null;
  const load = () =>
    (pending ??= factory().then((m) => {
      loaded = m.default;
      return m;
    }));
  const Lazy = lazy(load);
  function Preloaded(props: ComponentProps<C>) {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  return Object.assign(Preloaded, { preload: load });
}

/** A piece drawn only after a tap or inside a page, never in the shell's
 *  first paint: its code loads later, and it holds its own (empty) place
 *  while it does, so nothing around it suspends. The dashboard's first load
 *  had 0.2 KB left of its budget with these in the shell (#4945). */
export function deferredPiece<C extends ComponentType<any>>(factory: () => Promise<{ default: C }>): ((props: ComponentProps<C>) => ReactElement) & { preload: () => Promise<unknown> } {
  const Piece = lazyWithPreload(factory);
  const Held = (props: ComponentProps<C>) => (
    <Suspense fallback={null}>
      <Piece {...props} />
    </Suspense>
  );
  return Object.assign(Held, { preload: Piece.preload });
}

// A lazy component that, once its code is in, draws at once (#6563).
//
// React.lazy suspends on its first render even when the code has already
// loaded: the dashboard's "What do you want to do?" panel showed its 18rem
// placeholder for a frame and then grew to its real height, pushing the page
// down 600 px under the reader. Preloaded with `.preload()`, this renders the
// loaded component directly, never through the placeholder.
import { lazy, type ComponentProps, type ComponentType } from "react";

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

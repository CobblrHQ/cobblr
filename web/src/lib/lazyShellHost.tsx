// A host the shell loads after its first paint (the side panel's tabs, the
// command palette, quick add, photo capture, feedback, the tour) is optional:
// the page works without it. Its code comes over the network like anything
// else, so a device that goes offline before it arrives must not lose the
// page for it. A bare lazy() throws the failed import to the app's error
// boundary, which took it for a stale deploy and reloaded the app, offline,
// throwing away an open form (#6482). Here the host renders nothing until it
// can load, and asks again when the device is back online.
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";

class Quiet extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[shell-host] not loaded yet:", error.message);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Typed as React.lazy is: the props come from the module it loads.
export function lazyShellHost<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): ComponentType<ComponentProps<T>> {
  function ShellHost(props: ComponentProps<T>) {
    const [attempt, setAttempt] = useState(0);
    const [waiting, setWaiting] = useState(false);
    // A rejected lazy() stays rejected; each attempt is a fresh one.
    const Host = useMemo(() => lazy(load), [attempt]);
    useEffect(() => {
      if (!waiting) return;
      const again = () => {
        setWaiting(false);
        setAttempt((n) => n + 1);
      };
      window.addEventListener("online", again);
      return () => window.removeEventListener("online", again);
    }, [waiting]);
    return (
      <Quiet key={attempt} onFail={() => setWaiting(true)}>
        <Suspense fallback={null}>
          <Host {...(props as ComponentProps<typeof Host>)} />
        </Suspense>
      </Quiet>
    );
  }
  return ShellHost;
}

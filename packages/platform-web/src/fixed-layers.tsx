// The other things that are `position: fixed` and are NOT chrome.
//
// An OverlayLayer covers the page (a sheet, a lightbox, the command palette,
// the phone menu). It raises the overlay flag itself, so every piece of
// floating chrome that yields gets out of its way: an overlay that forgot the
// flag is how the sandbox strip ended up over the camera's shutter.
//
// A PopoverLayer is a transient surface anchored to a trigger and positioned
// from a measured rect (a menu, the "more" fold, an account flyout). It closes
// on an outside click and takes no room, so the dock and the flag are not
// its business.
//
// A BackdropLayer is the invisible click-catcher a popover puts behind itself.
//
// Each spells the position through floating-chrome.css, and lint:fixed-chrome
// refuses a bare `fixed` outside this package, so an author reaching for one
// has to say which of these it is.

import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { OverlayFlag } from "./overlay-open";

export interface LayerProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  style?: CSSProperties;
}

/** A surface that covers the page. Raises the overlay flag while mounted. */
export const OverlayLayer = forwardRef<HTMLDivElement, LayerProps>(function OverlayLayer({ className = "", children, ...rest }, ref) {
  return (
    <div ref={ref} className={"fc-overlay " + className} {...rest}>
      <OverlayFlag />
      {children}
    </div>
  );
});

/** A transient surface anchored to a trigger; position it with `style`. */
export const PopoverLayer = forwardRef<HTMLDivElement, LayerProps>(function PopoverLayer({ className = "", children, ...rest }, ref) {
  return (
    <div ref={ref} className={"fc-popover " + className} {...rest}>
      {children}
    </div>
  );
});

/** The click-catcher behind a popover: covers the page, draws nothing. */
export const BackdropLayer = forwardRef<HTMLDivElement, LayerProps>(function BackdropLayer({ className = "", children, ...rest }, ref) {
  return (
    <div ref={ref} className={"fc-backdrop " + className} {...rest}>
      {children}
    </div>
  );
});

/** For a layer that must be a button (a keyboard-invisible click-catcher) or
 *  another tag: the class names, so the tag stays the caller's. */
export const OVERLAY_LAYER_CLASS = "fc-overlay";
export const POPOVER_LAYER_CLASS = "fc-popover";
export const BACKDROP_LAYER_CLASS = "fc-backdrop";

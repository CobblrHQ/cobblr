// The height caps for every activity feed in the app.
//
// A feed is a list with no natural end: recent calls, AI activity, the audit
// log. Left uncapped it pushes everything below it off the screen and turns a
// settings page into an infinite scroll where the controls are at the top and
// unreachable. The dashboard already capped its feed at 28rem and scrolled
// within; the AI page, Integrations and the activity log each ran forever
// instead, so the same list behaved differently depending on where you met it.
//
// Kept as a shared constant rather than four copies of the same magic number,
// so changing the cap changes it everywhere and a new feed inherits it by
// importing rather than by remembering.

/** Cap + scroll for a feed that renders its own container (a <ul>/<div> with
 *  the border and background). */
export const FEED_SCROLL = "max-h-[28rem] overflow-y-auto";

/** Same cap for a feed inside a bordered wrapper that must keep its rounded
 *  corners: the wrapper clips, the inner element scrolls. */
export const FEED_SCROLL_INNER = "max-h-[28rem] overflow-y-auto overflow-x-auto";

/** For a page whose list IS the page: the activity log, the background queue,
 *  the OpenAPI path browser. 28rem is right for a feed sharing a page with
 *  other controls, and wrong here — it turns the main content into a letterbox
 *  with dead space under it. These fill the viewport and scroll inside, so the
 *  page itself never grows and the controls above stay put.
 *
 *  The 15rem covers the app chrome above: navbar, breadcrumb, page header.
 *  Bounded either way, just at the size the content deserves. */
export const FEED_SCROLL_PAGE = "max-h-[calc(100dvh-15rem)] overflow-y-auto";

/** Same, for a bordered wrapper that must keep its rounded corners. */
export const FEED_SCROLL_PAGE_INNER = "max-h-[calc(100dvh-15rem)] overflow-y-auto overflow-x-auto";

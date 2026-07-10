---
type: feature
scope: locations
date: 2026-07-10
docs_target: none (documented in USER_GUIDE.md in this commit; no release-timed doc surface exists yet)
---
**The floor plan's whole someday list, closed out.** The describe seed now also places the furniture you name (matched to existing sub-locations, never invents or overwrites); big rooms on a floor plan preview their contents inline from the zoomed-out view; members get read-only plans at `/portal/…/locations/…/plan`; and search results grew a where-is-it location chip. Plus the floor-plan end-to-end drive joins the e2e yardsticks.

## docs

The **describe** seed now also places the things you name: "grey metal rack against the back wall" drafts a true-scale rectangle matched to your existing sub-location by name (it never creates things and never moves what you've placed). On a big screen, a room drawn large enough previews its own contents inline; click still zooms. Search results show a location chip when the record knows where it lives. Members can view read-only plans at `/portal/‹workspace›/locations/‹id›/plan`; link it from the portal welcome text.

---
type: feature
scope: onboarding
date: 2026-08-01
docs_target: docs/USER_GUIDE.md#Guided tour
---
New workspaces get a short guided tour on first load, once per user and only while the workspace is still empty. It welcomes you, asks whether you want the navigation across the top or down a sidebar (and switches the whole app live as you try each), then spotlights the key parts of the dashboard one at a time. Skippable, and replayable any time from the account menu.

## docs

On your first visit to a workspace dashboard, a short guided tour appears. It opens by asking how you want to get around: **Top bar** runs your modules across the top of the screen, and **Full sidebar** puts everything in a column down the left. Picking one switches the whole app immediately, so you see the real layout before you commit, and you can change it any time.

The tour then walks you through the main areas one at a time, with a highlight on each and a short note about what it does. Use **Next** and **Back** to move through it, or **Skip** to leave at any point. To see it again later, open the account menu and choose **Take the tour**.

The steps are defined in one small config file (`web/src/tour/tour.config.ts`): each step points at a real element by a `data-tour` name, and a step whose element is not on the page is skipped, so the tour always matches the workspace in front of you.

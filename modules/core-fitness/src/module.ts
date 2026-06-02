// core-fitness — the LOG / GOAL / TREND primitive, first use = fitness.
//
// The shape inventory/lists can't express: a time series of MEASUREMENTS (a
// number at a timestamp for a named metric) plus a GOAL (target value) and a
// TREND you can see. Generalizes far past fitness — habits, budgets, mood,
// reading, plant-watering — anything "log a number over time toward a target".
//
// Two entity kinds: `metric` (the thing you track + its goal) and `measurement`
// (one logged data point). The trend chart is a new core-views renderer
// (view_type "trend") fed by the measurement list resolver.
// See docs/design-decisions/home-life-use-cases.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-fitness",
  version: "0.1.0",
  displayName: "Tracking",
  description:
    "Log a number over time toward a goal, and see the trend. Weight, runs, habits, budgets, mood — any measurement with a target. Ships a trend-chart view.",
  icon: "trending-up",
  band: "stock",
  autoEnable: false,

  schema: { tablePrefix: "core_fitness_", migrationsDir: "./migrations" },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "core-fitness:metric",
        displayName: "Metric",
        displayNamePlural: "Metrics",
        icon: "target",
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "unit", type: "text", role: "unit" },
          { name: "goal_value", type: "number" },
          { name: "goal_direction", type: "text" }, // "down" | "up" | "hit"
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["name", "unit", "goal_value", "goal_direction"],
        detailRoute: "/core-fitness/{id}",
        getEndpoint: "/metrics/{id}",
      },
      {
        id: "core-fitness:measurement",
        displayName: "Measurement",
        displayNamePlural: "Measurements",
        icon: "activity",
        profile: "auto-pruning-record",
        fields: [
          { name: "metric_id", type: "text", required: true },
          { name: "value", type: "number", required: true },
          { name: "measured_at", type: "date", role: "title" },
          { name: "note", type: "text", role: "summary" },
        ],
        exposableFields: ["metric_id", "value", "measured_at", "note"],
        getEndpoint: "/measurements/{id}",
      },
    ],
  },

  exposes: {
    events: [
      "core-fitness.metric.created",
      "core-fitness.metric.deleted",
      "core-fitness.measurement.logged",
      "core-fitness.goal.reached",
    ],
    api: [],
    actions: [
      {
        id: "core-fitness:log-measurement",
        label: "Log a measurement",
        description:
          "Record a number against a metric (by id, or by name — created on miss). Wire it to an event to feed a metric automatically (e.g. an order arriving → a 'Grocery spend' trend). Value comes from a static arg, a named event-payload key, or the wire template.",
        appliesTo: { any: true },
        invokeHandler: "core-fitness.log-measurement",
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});

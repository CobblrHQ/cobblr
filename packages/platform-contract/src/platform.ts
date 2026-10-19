import type { PlatformAccounts, PlatformEntitlements, PlatformMetering, PlatformTelemetry } from "@cobblr/platform-contract/overlay-seams";
import type { PlatformActions } from "@cobblr/platform-contract/module-actions";
import type { PlatformActivity, PlatformDeletedRecords, PlatformDispositions, PlatformEvents } from "@cobblr/platform-contract/activity-and-events";
import type { PlatformAddresses } from "@cobblr/platform-contract/overdue-and-addresses";
import type { PlatformAi } from "@cobblr/platform-contract/ai";
import type { PlatformAuth, PlatformQueue } from "@cobblr/platform-contract/queue-and-auth";
import type { PlatformCalendar } from "@cobblr/platform-contract/calendar";
import type { PlatformCatalogs, PlatformCategoryAxis, PlatformFields, PlatformPairings, PlatformTags } from "@cobblr/platform-contract/fields-tags-catalogs";
import type { PlatformConnections, PlatformEgress, PlatformSharedCache } from "@cobblr/platform-contract/connections";
import type { PlatformDb, PlatformOrgs, PlatformTenants } from "@cobblr/platform-contract/tenancy";
import type { PlatformDevices } from "@cobblr/platform-contract/devices";
import type { PlatformEdge } from "@cobblr/platform-contract/edge";
import type { PlatformEntities } from "@cobblr/platform-contract/platform-entities";
import type { PlatformExclusive, PlatformSweeps } from "@cobblr/platform-contract/sweeps";
import type { PlatformFiles } from "@cobblr/platform-contract/platform-files";
import type { PlatformHealth, PlatformRecurrence, PlatformTemplates, PlatformWires } from "@cobblr/platform-contract/wires-and-health";
import type { PlatformHostedPanels } from "@cobblr/platform-contract/hosted-panels";
import type { PlatformHttp } from "@cobblr/platform-contract/http";
import type { PlatformInstances } from "@cobblr/platform-contract/instances";
import type { PlatformIntegrations } from "@cobblr/platform-contract/integrations";
import type { PlatformLive, PlatformMoney, PlatformOutboundEmail, PlatformPanels, PlatformParts, PlatformResolvables, PlatformVault } from "@cobblr/platform-contract/platform-services";
import type { PlatformNav, PlatformUnits } from "@cobblr/platform-contract/units-and-nav";
import type { PlatformNotifications } from "@cobblr/platform-contract/notifications";
import type { PlatformPlacement } from "@cobblr/platform-contract/placement";
import type { PlatformScan, PlatformShares } from "@cobblr/platform-contract/scan-and-shares";
import type { PlatformServices } from "@cobblr/platform-contract/services";
import type { PlatformTidy } from "@cobblr/platform-contract/tidy";

export interface Platform {
  vault: PlatformVault;
  deletedRecords: PlatformDeletedRecords;
  dispositions: PlatformDispositions;
  money: PlatformMoney;
  activity: PlatformActivity;
  events: PlatformEvents;
  tenants: PlatformTenants;
  orgs: PlatformOrgs;
  resolvables: PlatformResolvables;
  db: PlatformDb;
  /** `fetch` against this api's own routes, handled in-process by its app:
   *  the same middleware (auth, tenant, rules) from the same remote address a
   *  loopback call had, with no socket to be refused under load (#4901).
   *  Takes "/api/v1/…" or a loopback URL to its own port; any other URL is an
   *  ordinary fetch, so a caller can pass whatever base it was given. Code in
   *  the api process calls this,
   *  never 127.0.0.1:$API_PORT (lint:no-loopback-to-self). */
  selfFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  entities: PlatformEntities;
  actions: PlatformActions;
  panels: PlatformPanels;
  parts: PlatformParts;
  live: PlatformLive;
  templates: PlatformTemplates;
  wires: PlatformWires;
  health: PlatformHealth;
  recurrence: PlatformRecurrence;
  calendar: PlatformCalendar;
  addresses: PlatformAddresses;
  queue: PlatformQueue;
  exclusive: PlatformExclusive;
  sweeps: PlatformSweeps;
  sharedCache: PlatformSharedCache;
  notifications: PlatformNotifications;
  outboundEmail: PlatformOutboundEmail;
  integrations: PlatformIntegrations;
  ai: PlatformAi;
  units: PlatformUnits;
  nav: PlatformNav;
  edge: PlatformEdge;
  connections: PlatformConnections;
  /** Outside work: services and their jobs (services.md §10). */
  services: PlatformServices;
  egress: PlatformEgress;
  auth: PlatformAuth;
  pairings: PlatformPairings;
  placement: PlatformPlacement;
  categoryAxis: PlatformCategoryAxis;
  tags: PlatformTags;
  fields: PlatformFields;
  catalogs: PlatformCatalogs;
  files: PlatformFiles;
  instances: PlatformInstances;
  scan: PlatformScan;
  shares: PlatformShares;
  devices: PlatformDevices;
  // Hosted-overlay seams (no-op / allow-all in open core):
  entitlements: PlatformEntitlements;
  tidy: PlatformTidy;
  metering: PlatformMetering;
  telemetry: PlatformTelemetry;
  accounts: PlatformAccounts;
  http: PlatformHttp;
  hostedPanels: PlatformHostedPanels;
}

# @cobblr/mcp-server

An **MCP server** that exposes a Cobblr install — cloud or self-hosted — to a
user's **own local Claude Code / Claude Desktop**, or to a **claude.ai connector**.
The model on the user's side drives the build; this process is a thin,
authenticated face over the existing `/api/v1` REST endpoints. It adds no new
backend.

## Why this shape (the auth boundary)

Anthropic's consumer (Free/Pro/Max) subscriptions may **not** be routed through a
third-party-hosted harness — that's a Consumer-ToS violation. The legitimate way to
let someone "use their Claude subscription to build their Cobblr app" is the
Cline/Zed pattern: **they** run their own Claude Code locally, and it connects to
*our* MCP server. Their machine, their subscription, sole beneficiary → allowed.

Consequence: this is a **power-user / self-hoster** channel (it requires Claude
Code/Desktop or a claude.ai connector). It is deliberately **not** the mainstream
onboarding path, and the product should depend on it for nothing. Full rationale:
`CobblrHQ/business-models/docs/09-byo-ai-and-auth-boundary.md`.

> MCP vs the HTTP API: same substance, different face. Local **Claude Code** can also
> just call the REST API via a skill doc; MCP is the zero-setup-per-session upgrade.
> **claude.ai chat** can *only* reach Cobblr through MCP (it can't make arbitrary
> authenticated HTTP calls), so MCP is required for that surface.

## Configuration

Station review reads are `cobblr_list_scan_stations`, `cobblr_list_scan_station_sessions`
and `cobblr_get_scan_station_session`. They use the same registry as Cobb. Sessions
include action times, things, their places before and after, and undo status. Follow
the session list's cursor to read older sessions.

Set via environment in your MCP client config:

| Var | Required | Default | Meaning |
|---|---|---|---|
| `COBBLR_API_TOKEN` | yes | — | A long-lived `cbt_…` API token (Cobblr → Settings → API tokens, or `POST /me/api-tokens`). Sent as `Authorization: Bearer`. |
| `COBBLR_BASE_URL` | no | `http://localhost:4000/api/v1` | Base URL incl. the `/api/v1` prefix. Cloud: `https://<host>/api/v1`. |
| `COBBLR_ORG_SLUG` | no | — | Default workspace slug, so per-tool `workspace` becomes optional. |

Nothing is persisted by this process; the token lives only in your MCP client config.

The tools offered follow the token: a token held to looking is offered no writes, one held to
changing records is not offered workspace setup, and one held to a workspace uses it as the
default. The server reads this from `GET /me` at start (see `src/offers.ts`).

## Install in Claude Code / Claude Desktop

Build it first (from the repo root): `npm run build -w @cobblr/mcp-server`.

Claude Desktop `claude_desktop_config.json` (or Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "cobblr": {
      "command": "node",
      "args": ["/absolute/path/to/CobblrHQ/core/packages/mcp-server/dist/index.js"],
      "env": {
        "COBBLR_BASE_URL": "http://localhost:4000/api/v1",
        "COBBLR_API_TOKEN": "cbt_…",
        "COBBLR_ORG_SLUG": "my-workspace"
      }
    }
  }
}
```

## Tools

Two tool families. The **build** tools (authoring + bundles) are registered
directly in `src/tools.ts`. The **operate** tools are generated from the shared
`@cobblr/workspace-tools` registry — one `cobblr_<name>` per entry — so this
server and the in-app Ask Cobb chat expose the same capabilities by
construction. That registry (`packages/workspace-tools/src/tools.ts`) is the
source of truth for the operate list below; add a tool there and both surfaces
get it.

### Build an app (authoring + bundles)

| Tool | Maps to | Mutates? |
|---|---|---|
| `cobblr_list_workspaces` | `GET /orgs` | no |
| `cobblr_list_templates` | `GET …/core-authoring/templates` | no |
| `cobblr_match_template` | `POST …/core-authoring/match-template` | no |
| `cobblr_get_template` | `GET …/core-authoring/templates/:id` | no |
| `cobblr_authoring_context` | `POST …/core-authoring/context` | no |
| `cobblr_authoring_compile` | `POST …/core-authoring/compile` | no (creates a draft) |
| `cobblr_authoring_candidate` | `POST …/core-authoring/drafts/:id/candidate` | no (validates) |
| `cobblr_authoring_repair_prompt` | `POST …/core-authoring/drafts/:id/repair-prompt` | no |
| `cobblr_authoring_apply` | `POST …/core-authoring/drafts/:id/apply` | **yes** |
| `cobblr_authoring_list_drafts` | `GET …/core-authoring/drafts` | no |
| `cobblr_authoring_get_draft` | `GET …/core-authoring/drafts/:id` | no |
| `cobblr_validate_bundle` | `POST …/bundles/validate` | no |
| `cobblr_install_bundle` | `POST …/bundles/install` | **yes** |

### Read and act on any app's data (operate)

Generated from `@cobblr/workspace-tools`, so the set matches the in-app chat:

- **Read** (no mutation): `cobblr_list_record_kinds`, `cobblr_list_records`, `cobblr_count_records` (exact totals, optionally grouped by a field — "how many", "which do I have most of"), `cobblr_get_record`, `cobblr_search_records`, `cobblr_things_of_person` (everything one person owns across every collection, by name or `me`), `cobblr_list_related`, `cobblr_list_actions`, `cobblr_list_scan_inbox` (the captures waiting to be filed — a queue, not a record kind, so `list_records` cannot see it; `facet:` narrows to needs_review / waiting / unfiled / ready), `cobblr_get_scan_item` (one inbox item in full: every field it would file with and where each came from, confidence, why it is flagged, where it goes, its pictures as links, its history, and `history_words`: each step in plain words with the revision `cobblr_put_back_scan_item` takes), `cobblr_preview_wire` (how many existing records a wire would fire on, and what that count means for its trigger, before it is added), `cobblr_get_putaway_plan`, `cobblr_replan_putaway`, `cobblr_list_label_codes`, `cobblr_read_bench` (instrument connection and paged recorded measurements), `cobblr_read_laser_batch` (drawings, material profiles, paged saved layouts and live controller setup), `cobblr_read_fabrication_floor` (all active queues, material totals, dispatch layouts and restock needs)
- `cobblr_read_laser_batch` with `cutter_profiles` or `cutter_station` reads paged cutter profiles and current station plans, jobs and native roll stock. Cutter planning, profile writes, outcomes and controls use `cobblr_invoke_action` with `digifab:cutter-batch` or `digifab:cutter-control`; physical Start still requires station authorization.
- **Read — what is happening, not only what exists**: `cobblr_get_attention` (the dashboard's "needs you" feed: low stock, overdue and upcoming dates, waiting captures — the best first call for an open-ended "what should I do?"), `cobblr_list_activity` (the history: who changed what, when), `cobblr_list_notifications` ("what did I miss?"), `cobblr_list_my_feedback` (your own reports and their replies filed in this workspace, with a total and cursor; pass `next_cursor` while `has_more` is true), `cobblr_list_maintenance` (service work due and done; `terms: true` reads paid renewal terms, documents and currency-separated annual and lifetime spend), `cobblr_list_calendar` (a date window, defaulting to today→+30d on its own; each event says `where` when it has an address), `cobblr_find_addresses` (the places this workspace already used on an address field, matched on a name or street, with the record each was used on: look one up before writing an address so a repeat is spelled the same), `cobblr_list_suggestions` (edits and additions the people you share with suggested, by record and person; decide them with the `platform:accept-suggestions`, `reject-suggestions`, `take-additions` and `leave-additions` actions). `cobblr_get_my_notification_delivery` (why a notification did or did not reach the person's phone or computer: their push devices with each one's last delivery or failure, their push threshold and quiet hours, what quiet hours are holding, and what this workspace's latest notifications were sent by); send a test push to one of those devices or remove it with `cobblr_invoke_action` (`platform:test-push-device`, `platform:remove-push-device`); the threshold and quiet hours stay the person's own. Records say what the workspace *has*; these say what *happened* and what is *coming*.
- **Read — escort (tier 1.5)**: `cobblr_take_user_to` — walk the user to a screen the assistant may never operate (members & invites, API tokens, backup & restore, AI providers, the wire composer, field editing), optionally prefilling the form (`prefill.*` params only pages that opt in will read). In the Cobblr app this moves the user's screen; from an external client it returns the path to hand them. Nothing is ever submitted — the page's own button, under the page's own role checks, is the consent.
- **Read — how the workspace is SET UP, not what it holds**: `cobblr_get_workspace_setup` — its instances (the separate lists one module runs), saved views, automations (wires), the apps the user built, entity templates and custom units. `part:` picks one area; omitting it summarises all of them. Each area degrades on its own, so a module that isn't enabled drops out of the answer instead of failing the call.
- **Services** (work a provider does: print a label, render a model, look something up): `cobblr_list_services` (what this workspace can ask for, and with `capability:` the options of one), `cobblr_invoke_service` (start a job; one that acts in the physical world waits for a person's yes on its card, whatever the caller, and `after:` can arm "do this when that job finishes"), `cobblr_get_service_job` (status, the question it is asking, and when done its output and files). Offered only when the workspace has a service to ask.
- **Add a thing the person has** (a printer, a book, a spool): `cobblr_add_thing`, not `create_record`. It runs the scan inbox's own intake, the same one a scan gets: the duplicate check, the table and category, the table's fields filled from what the name, code or link says, a picture and a place. It answers with what it found, `already_have` when the thing is already there, and `hints` (the table's fields still empty: ask your person). It always lands in the inbox first, marked as from an assistant; `file: true` files it in the same call unless it is already there (`allow_duplicate: true` overrides). It lands where the workspace already keeps the same thing (the record it already is, else its twins in the inbox), the most specific list first: a 3D printer goes to 3D Printers, not generic Machines, every time. `fields` (by the table's field names or labels) are placed on the table it was routed to; the answer lists `fields_kept` and `fields_refused` with the reason (no such field, with the one it probably meant; not a number; not one of a closed list's choices), so say what was not kept. `roles` takes values by what they are, whatever the workspace calls the field: `acquired-from`, `seller`, `acquired-on`, `acquired-for`; the seller goes to the table's seller field, else beside where it was bought ("3DPrintopia 2026 · RainMotorSports"). "(from Name)" after the name is the seller too. `goes_to` is the list your person named ("3D Printers"), kept as their choice. `cobblr_list_record_kinds` shows each field's role and whether its list takes new values before you add; `cobblr_update_record` takes the same `roles`.
- **File inbox items into a list**: `cobblr_file_inbox_items` with `ids` (from `cobblr_list_scan_inbox`, or the ones your person picked) and `list` (its name as the app shows it). The tool and dashboard Add all use the same selected-item batch API. Each becomes a record in that list through the inbox's own filing, the same as pressing File. Per-item failures are reported and leave the remaining items free to file. Through Cobb it is one change with one Undo that puts every item back in the inbox; "make a Mugs list and file these in it" is `platform:create-instance` then this, as one plan.
- **Put a scan item back**: `cobblr_put_back_scan_item` with `id` restores the item as it was before its newest change (a lookup that renamed it wrongly), every field: name, brand, barcode, pictures, kind. Pass `revision` from `cobblr_get_scan_item`'s `history_words` to put back an earlier step instead. The same as **Put back** on the card's History and **Undo** on its "Lookup updated" toast; the put-back is itself in History, so it can be put back in turn.
- **Write** (permission-checked server-side; the in-app chat routes these same writes through its Confirm gate): `cobblr_create_record`, `cobblr_create_records`, `cobblr_update_record`, `cobblr_delete_record`, `cobblr_invoke_action`, `cobblr_invoke_action (digifab:laser-batch)` (import or edit material profiles, plan, queue or discard a laser layout; physical Start still requires station approval). `cobblr_invoke_action (digifab:dispatch-material)` previews a batch across matching lasers, verifies and queues saved layouts, or withdraws an unqueued batch. **A SET is one call**: `cobblr_create_records` takes up to 200 records of one kind ("shelf 1 to 5 in every rack") instead of a loop over `create_record` - one round trip, one line in the user's chat, one undo that puts all of them back, and anything already there is reported rather than duplicated. Configuration is written the same way: a config change registers a **workspace-scoped action** (`labels:set-code`, `core-units:add-unit`, `core-views:save-view`) and rides `invoke_action`, so it inherits the confirm gate, the permission check and the change ledger instead of needing a bespoke tool per setting.

(Plus the `cobblr_drive_*` browser-driving tools — see `docs/modules/mcp-server.md`.)

### The operate loop (read + act on any app's data)

A second loop, alongside authoring — generic over every module + every app the user built:

1. `cobblr_list_record_kinds` → what kinds the workspace holds (`inventory:part`, …)
2. `cobblr_list_records` / `cobblr_search_records` / `cobblr_get_record` → read the data
3. `cobblr_list_actions kind=<k>` → the verbs that apply + their args
4. `cobblr_invoke_action`, or `cobblr_create_record` / `cobblr_update_record` /
   `cobblr_delete_record` → do it (adjust stock, mark a task done, add or edit a
   record, …); permission-checked server-side.

### The build loop the model follows

1. `cobblr_list_workspaces` → pick a slug (or rely on `COBBLR_ORG_SLUG`)
2. `cobblr_authoring_context` → see entity kinds + wireable actions
3. `cobblr_authoring_compile` → intent → draft + compiled prompt
4. *(model composes a bundle manifest from the prompt)*
5. `cobblr_authoring_candidate` → kernel validates; nothing applied yet
6. invalid? → `cobblr_authoring_repair_prompt` → fix → resubmit (5)
7. `cobblr_authoring_apply` → install the validated bundle

The kernel owns correctness: no manifest is applied until it validates, regardless
of which model produced it.

## Develop

```bash
npm run dev      -w @cobblr/mcp-server   # tsx, stdio
npm run dev:http -w @cobblr/mcp-server   # tsx, remote Streamable-HTTP (POST /mcp)
npm run build    -w @cobblr/mcp-server   # tsc → dist/
npm run typecheck -w @cobblr/mcp-server
```

**Two transports, same tools:** `cobblr-mcp` (stdio, local Claude) and
`cobblr-mcp-http` (remote Streamable HTTP — the surface claude.ai web needs; token
arrives per-request as a Bearer header). See `docs/modules/mcp-server.md` →
"Remote transport".

- `cobblr_read_kiln`: kiln telemetry, firing hours, wear reminders and paged firing logs.
- `cobblr_read_robot_arm`: a robot arm's state (connection, mode, program, safety, service), its programs by family and revision, its compatibility record and paged commands sent.
`cobblr_read_laser_batch` also reads large-format printer state and paged history
with `large_format_station` and `large_format_jobs`. Writes use
`digifab:large-format` through `cobblr_invoke_action`; Start still requires the
machine's authorized station credential. Stop uses `digifab:stop` without confirmation.

`cobblr_list_actions` accepts `send_targets: true` to list your other writable workspaces, their collections, and your recent sends from here. Connected Cobblrs also appear with their host and `connection_id`. Pass that id alongside `target_org` to send over the approved pairing. Pairing and revocation require personal approval in the app. Preview `platform:send-records` with `dry_run: true` (it answers the mapping in words and sends nothing), then send it with `cobblr_invoke_action`. `platform:undo-send` takes a send's id from that list and reverses a same-instance arrival and source move. For a connected send it first undoes the import there; call it again with `restore_source: true` to restore a moved source here separately. `connection_refusals` explains an unavailable destination. A connector or a token made for one workspace cannot send into another (it was granted only that one): `send_targets` says so, and sending needs a token made for all your workspaces.

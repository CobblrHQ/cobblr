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

Set via environment in your MCP client config:

| Var | Required | Default | Meaning |
|---|---|---|---|
| `COBBLR_API_TOKEN` | yes | — | A long-lived `cbt_…` API token (Cobblr → Settings → API tokens, or `POST /me/api-tokens`). Sent as `Authorization: Bearer`. |
| `COBBLR_BASE_URL` | no | `http://localhost:4000/api/v1` | Base URL incl. the `/api/v1` prefix. Cloud: `https://<host>/api/v1`. |
| `COBBLR_ORG_SLUG` | no | — | Default workspace slug, so per-tool `workspace` becomes optional. |

Nothing is persisted by this process; the token lives only in your MCP client config.

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

| Tool | Maps to | Mutates? |
|---|---|---|
| `cobblr_list_workspaces` | `GET /orgs` | no |
| `cobblr_authoring_context` | `POST …/core-authoring/context` | no |
| `cobblr_authoring_compile` | `POST …/core-authoring/compile` | no (creates a draft) |
| `cobblr_authoring_candidate` | `POST …/core-authoring/drafts/:id/candidate` | no (validates) |
| `cobblr_authoring_repair_prompt` | `POST …/core-authoring/drafts/:id/repair-prompt` | no |
| `cobblr_authoring_apply` | `POST …/core-authoring/drafts/:id/apply` | **yes** |
| `cobblr_authoring_list_drafts` | `GET …/core-authoring/drafts` | no |
| `cobblr_authoring_get_draft` | `GET …/core-authoring/drafts/:id` | no |
| `cobblr_validate_bundle` | `POST …/bundles/validate` | no |
| `cobblr_install_bundle` | `POST …/bundles/install` | **yes** |
| `cobblr_list_record_kinds` | `GET …/entity-kinds` | no |
| `cobblr_list_records` | `GET …/entities/:kind` | no |
| `cobblr_get_record` | `GET …/entities/:kind/:id` | no |
| `cobblr_list_actions` | `GET …/registered-actions` | no |
| `cobblr_invoke_action` | `POST …/actions/invoke` | **yes** |

(Plus the `cobblr_drive_*` browser-driving tools — see `docs/modules/mcp-server.md`.)

### The operate loop (read + act on any app's data)

A second loop, alongside authoring — generic over every module + every app the user built:

1. `cobblr_list_record_kinds` → what kinds the workspace holds (`inventory:part`, …)
2. `cobblr_list_records` / `cobblr_get_record` → read the data
3. `cobblr_list_actions kind=<k>` → the verbs that apply + their args
4. `cobblr_invoke_action` → do it (adjust stock, mark a task done, build one, …);
   permission-checked server-side.

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

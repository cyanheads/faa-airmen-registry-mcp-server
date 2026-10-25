# Developer Protocol

**Server:** faa-airmen-registry-mcp-server
**Version:** 0.2.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.16`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.3.1
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## FAA Data Privacy

- Hosted deployment keeps `FAA_AIRMEN_REDACT_PII=true`; personal local installs may opt out. Docker remains a supported deployment option.
- Never persist or return street addresses. Discard street columns before persistence; city and ZIP output require explicit operator opt-in.
- `FAA_AIRMEN_REDACT_PII` is on by default for every transport and applies at serving time only; it never changes what the mirror imports. While on, name-mode searches need both `lastName` and `firstName`, `nameMatch: "prefix"` and `city`/`zipCode` filters are refused, city and ZIP are omitted from output even with `FAA_AIRMEN_INCLUDE_LOCATION=true`, and `faa_airmen_check_medical_status` refuses every call. Refusals carry the reason `pii_redacted`, and every successful response carries `piiRedacted`. A personal local install that wants the full surface sets `FAA_AIRMEN_REDACT_PII=false`.
- Medical fields are informational FAA snapshot records. Never infer medical fitness, current operational privileges, instructor currency, or Part 107 recurrent-training currency.
- A missing airman is absent from the releasable snapshot, not evidence that a person is unlicensed.
- Raw FAA data and real personal fixtures must never be committed or packaged. Keep mirror data under `/data/`, excluded from Git, npm, MCPB, and Docker context; tests use synthetic identities.
- `docs/idea.md` is private design input and must stay excluded from every publication surface.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. The operator-owned FAA source mirror stays behind `AirmenRegistryService`; handlers never access SQLite directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

The six definitions live in `src/mcp-server/tools/definitions/`. Use `verify-certificate.tool.ts` for paged identity lookup, `check-medical-status.tool.ts` for ID-only output, and `list-reference.tool.ts` for references that work before initialization. No resources or prompts are registered.

Each handler calls `getAirmenRegistryService()`, passes `ctx` for cancellation, writes the returned enrichment with `ctx.enrich(result.enrichment)`, and returns `result.data`. Shared `formatResult` and the matching list/single trailer render every domain and enrichment value losslessly.

`src/config/server-config.ts` maps `mirrorDir`, `includeLocation`, `redactPii`, and `staleAfterDays` through `parseEnvConfig` to `FAA_AIRMEN_MIRROR_DIR`, `FAA_AIRMEN_INCLUDE_LOCATION`, `FAA_AIRMEN_REDACT_PII`, and `FAA_AIRMEN_STALE_AFTER_DAYS`. Location accepts only `true`/`false` and defaults off; redaction defaults on and only `false` (any case, trimmed) turns it off, so no value fails startup; stale age is an integer 1–366, default 45. The mirror directory defaults to platform user-data storage.

`createApp()` in `src/index.ts` sets bare `name` and `title`, declares `sessionMode: 'stateless'`, registers all six tools, and initializes the service in `setup()` without opening or downloading a mirror. A meaningful `MCP_SESSION_MODE` environment value still overrides the declaration. No handler requests client input. The compiled `dist/cli/mirror.js` alone handles operator `init`, `refresh`, `verify`, `status`, and `prune`; `src/cli/mirror-command.ts` holds its dispatch, cancellation, and output.

## Context

| Property | Use |
|:---|:---|
| `ctx.enrich` | Required provenance, effective filters, notices, and paging values on every success |
| `ctx.signal` | Cancellation during reads |
| `ctx.log` | Request-scoped diagnostics; never log names, IDs, medical values, city/ZIP, source rows, or local paths |

The FAA snapshot is operator-owned source data in the service layer, not tenant state. Use `ctx.state` for any future tenant-specific state. No tool requests client input or returns media.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

Each tool declares its recovery routes inline; service reasons are marked `thrownBy: 'service'`. For example, `faa_airmen_check_medical_status` routes `invalid_identity` through `faa_airmen_verify_certificate` name discovery, while `mirror_missing` routes to reference topic `mirror_status` and operator initialization. Missing IDs and absent medical fields are successful results, never fabricated error verdicts.

**Declare contracts inline on each tool.** The contract is part of the tool's public surface. Do not extract a shared `errors[]` constant or attach personal values, SQL, raw source errors, or local paths to an error.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts
  cli/
    mirror.ts
    mirror-command.ts
  config/server-config.ts
  services/airmen/
    airmen-registry-service.ts
    airmen-mirror.ts
    importer.ts
    source.ts
    reference.ts
    contracts.ts
    types.ts
    mirror-error.ts
  mcp-server/tools/
    definitions/*.tool.ts
    schemas.ts
    render.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `verify-certificate.tool.ts` |
| Tool/resource/prompt names | snake_case, `faa_airmen_` prefix | `faa_airmen_verify_certificate` |
| Directories | kebab-case | `src/services/airmen/` |
| Descriptions | Single string or template literal, no `+` concatenation | Copy the accurate contract from the tool definition |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run mirror:init` | Initialize the FAA snapshot through compiled Node CLI |
| `bun run mirror:refresh` | Download and publish a replacement snapshot |
| `bun run mirror:verify` | Check the published snapshot read-only |
| `node dist/cli/mirror.js status` | Inspect readiness, refresh state, and superseded generations |
| `node dist/cli/mirror.js prune` | Delete generations `CURRENT` doesn't name; stop every server process first |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

Lifecycle scripts consume exported variables; Node does not load `.env` for the CLI automatically. Use `node --env-file=.env dist/cli/mirror.js <init|refresh|verify|status|prune>` when configuring from that file. MCP startup loads its own `.env`. Keep the mirror directory and location policy aligned between CLI and server.

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a stdio `.mcpb` for Claude Desktop. `scripts/clean-mcpb.ts` prunes development dependencies, dependency-shipped agent docs, and optional DuckDB platform packages. It does not strip the required `better-sqlite3` loader or prebuilt bindings: preserve those for Node consumers. The bundle contains the compiled lifecycle CLI but no FAA data; the operator initializes a separate persistent directory before lookup tools can read it. Client installation alone never imports a snapshot.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

Every release uses `git-wrapup`'s "Release PR mode", mode `straight-through`, through a `release/<version>` PR. After authorization, run `git-wrapup` then `release-and-publish`; merge locally with `git merge --ff-only`. Never squash, rebase, or merge through the GitHub UI or `gh pr merge`. Editing agents never commit, tag, push, or publish.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` and `bun run test` pass

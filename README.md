<div align="center">
  <h1>@cyanheads/faa-airmen-registry-mcp-server</h1>
  <p><b>Search FAA airmen certificates, ratings, and informational medical records via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/faa-airmen-registry-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faa-airmen-registry-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-airmen-registry-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faa-airmen-registry-mcp-server/releases/latest/download/faa-airmen-registry-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faa-airmen-registry-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFhLWFpcm1lbi1yZWdpc3RyeS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faa-airmen-registry-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaa-airmen-registry-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://faa-airmen-registry.caseyjhand.com/mcp](https://faa-airmen-registry.caseyjhand.com/mcp)

</div>

---

## Overview

FAA airmen certification records from the [Releasable Airmen Database](https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download), served from a local snapshot. Resolve names to separate identity candidates, read pilot and non-pilot certificates with their ordered ratings, find flight and ground instructors and remote pilots, and read informational medical fields.

Runs as a stdio process, a loopback Streamable HTTP server (directly or in Docker), or the public hosted endpoint above. A self-hosted operator builds the snapshot with a separate CLI; the server never downloads data, and no API key is needed.

### Tools

| Tool | Description |
|:---|:---|
| `faa_airmen_verify_certificate` | Find identity candidates by name or FAA Unique ID, optionally narrowed by certificate type, level, and ratings, and read their complete certificate records |
| `faa_airmen_get_type_ratings` | Read all pilot-family certificates and their aircraft type, category/class, and instrument ratings |
| `faa_airmen_check_medical_status` | Read informational medical and BasicMed fields without assessing fitness or eligibility |
| `faa_airmen_search_instructors` | Find flight and ground instructor records by name, state, and ratings |
| `faa_airmen_verify_remote_pilot` | Find releasable remote pilot certificate records by name or Unique ID |
| `faa_airmen_list_reference` | Read codes, interpretation guidance, observed type designators, and mirror status |

## Capability reference

### `faa_airmen_verify_certificate` <sub>tool</sub>

- `mode: "name"` requires `lastName`; `firstName`, `state`, `city`, and `zipCode` narrow it. `nameMatch` applies to each supplied name field: `words` (default) matches whole leading words, so `JOHN` finds the FIRST NAME `JOHN ROBERT` (FAA first names usually include middle names) and `SMITH` finds the LAST NAME `SMITH JR`; only a space separates words, so `SMITH` does not find `SMITH-JONES`. `exact` compares the whole field, and `prefix` matches from its beginning, mid-word included
- `mode: "id"` takes one `uniqueId`, an opaque A or C plus seven digits that is not a certificate number, and rejects name and location fields
- `certificateType` (a type letter, its reference topic `certificate_types` description such as `remote pilot` or `flight_instructor` in any case, or `CFI`) selects people but returns all their certificates; people sharing a name stay separate candidates
- `certificateLevel` (one letter from reference topic `certificate_levels`; requires `certificateType`), `ratingCodes` (1–11 codes from topic `ratings`), and `typeRatings` (1–11 designators from topic `type_ratings`, such as `B-737`) narrow candidates further. Every requested credential must sit on one certificate, and matches still return all their certificates. Repeats collapse. A bare code or designator matches any level, and `level/code` only that slot's level: `A/B-737` is a type rating held at ATP level, while `certificateLevel: "A"` with `B-737` asks for an ATP certificate carrying it at any level, `C/B-737` included
- A zero result with credential filters says how many people the name search matches without them, so a name miss reads apart from a credential miss
- With `FAA_AIRMEN_REDACT_PII` on (the default), name mode needs both `lastName` and `firstName` and refuses `nameMatch: "prefix"`, `city`, and `zipCode` with `pii_redacted`; city and ZIP are omitted from results

---

### `faa_airmen_get_type_ratings` <sub>tool</sub>

- One `uniqueId` from `faa_airmen_verify_certificate`; returns every certificate from the FAA pilot files with ordered `ratings` and `typeRatings` slots, each keeping its `raw` value, `ordinal`, and `code`
- `found: false` for an unknown ID; a known person with only non-pilot certificates gets an empty `certificates` array

---

### `faa_airmen_check_medical_status` <sub>tool</sub>

- One `uniqueId`; returns each distinct reported medical record: `medicalClass`, `medicalDateRaw` and `medicalExpireDateRaw` (normally MMYYYY), and the BasicMed course and checklist dates (normally YYYYMMDD)
- `found` separates an unknown ID from a known person, and `hasReportedMedicalFields: false` means nothing was reported, never an adverse finding. Every result carries a `disclaimer`: the fields are informational, not evidence of fitness or eligibility
- With `FAA_AIRMEN_REDACT_PII` on (the default), every call is refused with `pii_redacted`

---

### `faa_airmen_search_instructors` <sub>tool</sub>

- Needs at least one of `lastName`, `firstName`, `state`, `city`, `zipCode`, or `ratingCodes`; `instructorType` is `flight` (F), `ground` (G), or `both` (default)
- `ratingCodes` takes 1–11 codes from reference topic `ratings`, all required on the same certificate; repeats collapse. A bare code matches any source level, and `level/code` (the `raw` form results return, such as `F/INSTA`; the level is one letter) only that level. CFII is `INSTA`, `INSTH`, `INSTI`, or `INSTP` on F and MEI is `AME` or `ASME`; `INST`, `ADV`, and `BASIC` occur only on G
- With `FAA_AIRMEN_REDACT_PII` on (the default), a name search needs both `lastName` and `firstName`, and `nameMatch: "prefix"`, `city`, and `zipCode` are refused with `pii_redacted`; city and ZIP are omitted from results
- Matches carry their complete qualifying `instructorCertificates`. Legacy expiry fields don't establish currency, and CFI certificates no longer expire under the December 2024 rule

---

### `faa_airmen_verify_remote_pilot` <sub>tool</sub>

- Same `mode`, `uniqueId`, and name selectors as `faa_airmen_verify_certificate`; returns only people holding U certificates, with all of them in `remotePilotCertificates`
- With `FAA_AIRMEN_REDACT_PII` on (the default), the same name restrictions apply: both names required, and `nameMatch: "prefix"`, `city`, and `zipCode` refused with `pii_redacted`
- Certificate presence doesn't establish Part 107 recurrent-training currency or operating authority

---

### `faa_airmen_list_reference` <sub>tool</sub>

- `topic` is `certificate_types`, `certificate_levels`, `ratings`, `type_ratings`, `identifiers`, `medical_guidance`, or `mirror_status`; the four vocabulary topics take a case-insensitive `filter` of up to 80 characters
- Static topics and `mirror_status` answer before a snapshot exists; `type_ratings` lists the designators observed in the imported snapshot
- `mirror_status` returns `mirrorStatus.state` (`missing`, `ready`, `unavailable`), `refreshState` (`idle`, `running`, `failed`), `lastRefreshFailure` (the stage of a refresh that didn't complete, such as `acquisition`, `validation`, `disk`, `cancelled`, `timeout`, or `interrupted` for one whose process ended without recording a result), and the latest generation's provenance, without filesystem paths

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAA-specific:

- Offline SQLite lookups over the four monthly source files (`PILOT_BASIC`, `NONPILOT_BASIC`, `PILOT_CERT`, `NONPILOT_CERT`), joined by FAA Unique ID, keeping every distinct certificate and differing identity variant
- Street addresses are discarded before anything is stored. City and ZIP import, output, and filtering need `FAA_AIRMEN_INCLUDE_LOCATION=true`; state is always available
- Serving-time redaction is on by default (`FAA_AIRMEN_REDACT_PII`, only `false` turns it off): name searches need first and last name, `prefix` matching and city/ZIP filters are refused, city and ZIP are omitted from output, and `faa_airmen_check_medical_status` refuses every call. Refusals carry the reason `pii_redacted`, every successful response carries `piiRedacted`, and the mirror import is unaffected
- The `faa-airmen-registry-mirror` CLI downloads and validates each snapshot into an immutable generation; a failed refresh leaves the last complete one serving
- The FAA omits airmen who withhold address release and publishes no certificate numbers or recurrent-training dates. A miss is not evidence that someone is uncertificated, and a match is not a current-privilege determination; use the [FAA's official services](https://www.faa.gov/licenses_certificates/airmen_certification) for authoritative answers

Agent-friendly output:

- Provenance on every snapshot-backed response: source name, snapshot month, source age with a `stale` flag, generation ID, and the generation's location import policy, plus the normalized `appliedFilters`; `faa_airmen_list_reference` topic `mirror_status` returns the full record, including hashes, row counts, and source-quality warning counts
- Whole-record paging: list tools return complete people within a ~24 KiB response budget, so `limit` (default 10, at most 50; a larger limit returns 50 with a notice) is an upper bound. `totalCount`, `returnedCount`, and `nextOffset` describe the actual page; offsets stop at 10,000, where `atPagingCap` asks for narrower filters
- A published Agent Skill, `faa-airmen-registry-guide`, served over MCP as `skill://faa-airmen-registry-guide/SKILL.md` and shipped in the plugin, npm package, `.mcpb`, and image: mapping CFII, MEI, ATP, and type-rating shorthand to codes, one call per alternative code, name matches that miss silently, reading each rating at its own level, and the stop rule before reporting a credential absent
- Typed failures that name the next call: `mirror_missing`, `location_access_disabled`, `pii_redacted`, `invalid_filter`, and the other declared reasons each carry a recovery step. A validation failure names the field and its expected form (`state must be a two-letter state or territory code.`), never the value, and empty pages still return totals and guidance

## Getting started

Connect to the hosted instance, no install or snapshot:

```sh
claude mcp add --transport http faa-airmen-registry-mcp-server https://faa-airmen-registry.caseyjhand.com/mcp
```

The hosted instance runs with redaction on: name searches need both first and last names, `nameMatch: "prefix"` and city/ZIP searches are refused, and medical lookups are unavailable. Whole leading words remain supported by the default `words` matching. For the full surface, self-host with `FAA_AIRMEN_REDACT_PII=false`.

Or run it locally. A local install serves its own snapshot, so build it before connecting a client:

```sh
export FAA_AIRMEN_MIRROR_DIR="$HOME/.local/share/faa-airmen-registry-mcp-server"
npx -y --package @cyanheads/faa-airmen-registry-mcp-server faa-airmen-registry-mirror init
```

`init` downloads the FAA archive (about 57 MB) and builds a ~1.75 GB snapshot in about 12 minutes; allow about 3 GB of disk. Point the MCP client at the same `FAA_AIRMEN_MIRROR_DIR`, and set `FAA_AIRMEN_REDACT_PII=false` on a personal install that wants the full surface. Refreshing, pruning old generations, and keeping city and ZIP are covered in [docs/snapshot.md](./docs/snapshot.md).

Then add it to Claude Code with the same snapshot directory:

```sh
claude mcp add faa-airmen-registry-mcp-server -e FAA_AIRMEN_MIRROR_DIR="$FAA_AIRMEN_MIRROR_DIR" -- npx -y @cyanheads/faa-airmen-registry-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/faa-airmen-registry-mcp-server"],
      "env": { "FAA_AIRMEN_MIRROR_DIR": "/absolute/path/to/airmen-mirror" }
    }
  }
}
```

For Docker, Streamable HTTP, or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FAA_AIRMEN_MIRROR_DIR` | Persistent snapshot directory, shared by the CLI and the server. | Platform user-data directory plus `faa-airmen-registry-mcp-server` |
| `FAA_AIRMEN_INCLUDE_LOCATION` | `true` opts in to city and ZIP import, and to output and filtering when `FAA_AIRMEN_REDACT_PII=false`; `false` disables them. | `false` |
| `FAA_AIRMEN_REDACT_PII` | Serving-time redaction, on by default; only `false` (any case) turns it off, and any other value leaves it on. Never changes what the mirror imports. | `true` |
| `FAA_AIRMEN_STALE_AFTER_DAYS` | Source-age warning threshold, integer 1–366; never a credential verdict. | `45` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`; a meaningful value overrides the server's `stateless` declaration. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides. Framework storage settings don't relocate the FAA snapshot.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+) and about 3 GB of persistent local storage for the snapshot; network access is needed only for `init` and `refresh`. Under Node, `better-sqlite3` loads prebuilt bindings for macOS, Linux, and Windows on x64 and arm64 with no compiler step. Execution is tested on macOS under Node and Bun.

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/faa-airmen-registry-mcp-server.git
  cd faa-airmen-registry-mcp-server && bun install
  cp .env.example .env
  # set FAA_AIRMEN_MIRROR_DIR, and FAA_AIRMEN_INCLUDE_LOCATION if you want city and ZIP
  # FAA_AIRMEN_REDACT_PII=false lifts serving-time redaction on a personal local install
  ```

- **Build, initialize the snapshot, and run:**

  ```sh
  # One-time build and snapshot
  bun run rebuild
  node --env-file=.env dist/cli/mirror.js init

  # Run the built server
  bun run start:stdio
  # or, on loopback at http://127.0.0.1:3010/mcp
  bun run start:http
  ```

  The CLI doesn't load `.env` itself; pass `--env-file=.env` or export the variables.

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

The image keeps its snapshot in `/data/airmen`, so initialize a named volume first; run the same command with `refresh`, `verify`, or `status` for maintenance, and with `prune` once every server container using the volume is stopped:

```sh
docker volume create faa-airmen-data
docker run --rm -v faa-airmen-data:/data/airmen ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest bun dist/cli/mirror.js init
docker run --rm -p 127.0.0.1:3010:3010 -v faa-airmen-data:/data/airmen ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/faa-airmen-registry-mcp-server`; the last command publishes it on loopback only, at `http://127.0.0.1:3010/mcp`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-v", "faa-airmen-data:/data/airmen", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest"]`. To build locally, `docker build -t faa-airmen-registry-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), shared schemas, and lossless rendering. Six read-only tools. |
| `src/services/airmen` | FAA acquisition, streaming import, immutable snapshot lifecycle, queries, and reference tables. |
| `src/cli` | The `faa-airmen-registry-mirror` operator CLI. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `skills/` | The published `faa-airmen-registry-guide` Agent Skill for agents calling the tools. |
| `tests/` | Synthetic-source lifecycle, query, and MCP contract tests. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- The snapshot is operator-owned and read-only; keep it in the service layer and use `ctx.state` only for tenant state
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Validate source rows → normalize to domain types → return the output schema; never fabricate missing fields, never persist street addresses, and use synthetic identities in tests and examples

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

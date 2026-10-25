<div align="center">
  <h1>@cyanheads/faa-airmen-registry-mcp-server</h1>
  <p><b>Search FAA airmen certificates, ratings, and informational medical records via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/faa-airmen-registry-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faa-airmen-registry-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-airmen-registry-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
- Typed failures that name the next call: `mirror_missing`, `location_access_disabled`, `pii_redacted`, `invalid_filter`, and the other declared reasons each carry a recovery step. A validation failure names the field and its expected form (`state must be a two-letter state or territory code.`), never the value, and empty pages still return totals and guidance

## Getting started

### Public Hosted Instance

A public instance is available at `https://faa-airmen-registry.caseyjhand.com/mcp` — no installation or snapshot required. It serves Streamable HTTP; each client takes its own config shape.

For Claude Code:

```sh
claude mcp add --transport http faa-airmen-registry-mcp-server https://faa-airmen-registry.caseyjhand.com/mcp
```

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "type": "streamableHttp",
      "url": "https://faa-airmen-registry.caseyjhand.com/mcp"
    }
  }
}
```

For Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "url": "https://faa-airmen-registry.caseyjhand.com/mcp"
    }
  }
}
```

Claude Desktop adds remote servers under Settings → Connectors.

The hosted instance runs with redaction on: name searches need both first and last names, `nameMatch: "prefix"` and city/ZIP searches are refused, and medical lookups are unavailable. Whole leading words remain supported by the default `words` matching. For the full surface, self-host with `FAA_AIRMEN_REDACT_PII=false`.

### Self-Hosted / Local

A local install serves its own snapshot, so build it before connecting a client:

```sh
export FAA_AIRMEN_MIRROR_DIR="$HOME/.local/share/faa-airmen-registry-mcp-server"
npx -y --package @cyanheads/faa-airmen-registry-mcp-server faa-airmen-registry-mirror init
```

`init` downloads the current FAA archive (about 57 MB) and builds a SQLite generation of about 1.75 GB; it took about 12 minutes in testing. The importer also keeps a 1 GiB free-space reserve, so allow about 3 GB. The same CLI runs `verify`, `status`, `refresh`, and `prune`. `refresh` builds the next generation beside the current one (another ~1.75 GB) and never deletes old ones, since a running server may still be reading one. `status` reports how many superseded generations there are and their size. Stop every server process that uses the mirror, then run `prune`: it takes the writer lock, refuses unless the published snapshot is ready, deletes every generation `CURRENT` doesn't name, and prints what it removed and the bytes freed. Deleting a generation a server still has open can fail that server's lookups (Bun on macOS) or the deletion itself (Windows).

Point the MCP client at the same `FAA_AIRMEN_MIRROR_DIR`; left unset, both use the platform user-data directory. To keep city and ZIP, set `FAA_AIRMEN_INCLUDE_LOCATION=true` for both import and serving; a snapshot imported without it needs a `refresh` after enabling. Output redaction is on by default and applies at serving time only; a personal local install that wants the full surface (medical lookups, partial-name and city/ZIP searches, city and ZIP in output) sets `FAA_AIRMEN_REDACT_PII=false` on the server.

### MCP client configuration

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/faa-airmen-registry-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "FAA_AIRMEN_MIRROR_DIR": "/absolute/path/to/airmen-mirror"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/faa-airmen-registry-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "FAA_AIRMEN_MIRROR_DIR": "/absolute/path/to/airmen-mirror"
      }
    }
  }
}
```

Or with Docker. The image keeps its snapshot in `/data/airmen`, so initialize a named volume first; run the same command with `refresh`, `verify`, or `status` for maintenance, and with `prune` once every server container using the volume is stopped:

```sh
docker volume create faa-airmen-data
docker run --rm -v faa-airmen-data:/data/airmen ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest bun dist/cli/mirror.js init
```

```json
{
  "mcpServers": {
    "faa-airmen-registry-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "faa-airmen-data:/data/airmen", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, start the server on loopback:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Or from the image, published on loopback only:
docker run --rm -p 127.0.0.1:3010:3010 -v faa-airmen-data:/data/airmen ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest
# Server listens at http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- About 3 GB of persistent local storage for the snapshot; network access is needed only for `init` and `refresh`.
- Under Node, `better-sqlite3` loads prebuilt bindings for macOS, Linux, and Windows on x64 and arm64 with no compiler step. Execution is tested on macOS under Node and Bun.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/faa-airmen-registry-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd faa-airmen-registry-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# set FAA_AIRMEN_MIRROR_DIR, and FAA_AIRMEN_INCLUDE_LOCATION if you want city and ZIP
# FAA_AIRMEN_REDACT_PII=false lifts serving-time redaction on a personal local install
```

5. **Build and initialize the snapshot:**

```sh
bun run rebuild
node --env-file=.env dist/cli/mirror.js init
```

The CLI doesn't load `.env` itself; pass `--env-file=.env` or export the variables.

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

- **Build and run the production version**:

  ```sh
  # One-time build and snapshot
  bun run rebuild
  node --env-file=.env dist/cli/mirror.js init

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), shared schemas, and lossless rendering. Six read-only tools. |
| `src/services/airmen` | FAA acquisition, streaming import, immutable snapshot lifecycle, queries, and reference tables. |
| `src/cli` | The `faa-airmen-registry-mirror` operator CLI. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
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

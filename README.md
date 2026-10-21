<div align="center">
  <h1>@cyanheads/faa-airmen-registry-mcp-server</h1>
  <p><b>Search FAA airmen certificates, ratings, and informational medical records via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![npm](https://img.shields.io/npm/v/@cyanheads/faa-airmen-registry-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-airmen-registry-mcp-server)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faa-airmen-registry-mcp-server/releases/latest/download/faa-airmen-registry-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faa-airmen-registry-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFhLWFpcm1lbi1yZWdpc3RyeS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faa-airmen-registry-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaa-airmen-registry-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Search a local copy of the [FAA Releasable Airmen Database](https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download). Resolve names to separate identity candidates, inspect pilot and non-pilot certificates, read ratings, find instructor and remote pilot records, and retrieve informational medical fields.

The operator initializes and refreshes the snapshot separately. MCP startup and tool calls never download it. This server is for local use through stdio or local Streamable HTTP, including Docker; no public hosted instance is provided. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `faa_airmen_verify_certificate` | Find identity candidates by name or FAA Unique ID and read their complete certificate records |
| `faa_airmen_get_type_ratings` | Read all pilot-family certificates and their aircraft type, category/class, and instrument ratings |
| `faa_airmen_check_medical_status` | Read informational medical and BasicMed fields without assessing fitness or eligibility |
| `faa_airmen_search_instructors` | Find flight and ground instructor records by name, state, and ratings |
| `faa_airmen_verify_remote_pilot` | Find releasable remote pilot certificate records by name or Unique ID |
| `faa_airmen_list_reference` | Read codes, interpretation guidance, observed type designators, and mirror status |

## Capability reference

### `faa_airmen_verify_certificate` <sub>tool</sub>

- `mode: "name"` requires `lastName`; optional `firstName`, `state`, `city`, and `zipCode` narrow candidates. `nameMatch` is `exact` by default or `prefix`; FAA first names include middle names and last names can include suffixes
- `mode: "id"` requires a returned `uniqueId` and excludes name/location selectors. IDs are opaque A/C plus seven digits, never certificate numbers
- Optional `certificateType` selects people while preserving all their certificates, including other types; names that collide remain separate candidates
- `limit` defaults to 10, at most 50; follow the actual `nextOffset` rather than adding the requested limit

---

### `faa_airmen_get_type_ratings` <sub>tool</sub>

- Takes one `uniqueId` obtained from `faa_airmen_verify_certificate`
- Returns every pilot-family certificate with complete ordered rating and type-rating arrays, source certificate type/level, raw values, and unknown codes
- A missing ID returns `found: false`; a known person with no pilot-family credentials returns an empty certificate array

---

### `faa_airmen_check_medical_status` <sub>tool</sub>

- Takes one `uniqueId`; returns all distinct reported medical records, including medical class, raw dates, and BasicMed dates when supplied
- Separates a missing person from a known person with no reported medical fields through `found` and `hasReportedMedicalFields`
- These fields are informational and are not authoritative evidence of medical certification, fitness, or eligibility to operate

---

### `faa_airmen_search_instructors` <sub>tool</sub>

- Requires at least one name, state, city, ZIP, or rating filter; `instructorType` is `flight`, `ground`, or `both` (default)
- Accepts 1–11 distinct `ratingCodes` from reference topic `ratings`; every requested code must occur on the same qualifying certificate
- Returns complete qualifying F/G certificates; legacy expiry fields do not establish instructor currency, and CFI certificates no longer expire under the December 2024 rule
- Uses the same bounded paging and location policy as certificate search

---

### `faa_airmen_verify_remote_pilot` <sub>tool</sub>

- Uses the same mutually exclusive ID/name selectors and paging as certificate search
- Returns only people with U certificates and all their remote pilot certificate records
- Certificate presence does not establish Part 107 recurrent-training compliance or current operating authority

---

### `faa_airmen_list_reference` <sub>tool</sub>

- Topics: `certificate_types`, `certificate_levels`, `ratings`, `type_ratings`, `identifiers`, `medical_guidance`, and `mirror_status`
- Static topics and `mirror_status` work before initialization; `type_ratings` reads designators observed in the imported snapshot
- Vocabulary topics accept a literal case-insensitive `filter` up to 80 normalized characters; all topics use `limit`/`offset` paging
- `mirror_status` reports readiness, refresh state, and available provenance without exposing filesystem paths

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAA-specific:

- Offline SQLite lookups join pilot and non-pilot source families by FAA Unique ID, retaining distinct certificates and source identity variants
- Street addresses are discarded before persistence. City and ZIP import, output, and filtering require explicit operator opt-in; state remains available
- Separate operator CLI downloads and validates a replacement before publishing it; a failed refresh preserves the last complete generation

Agent-friendly output:

- Snapshot provenance, source-age warnings, normalized applied filters, and interpretation notices accompany results; importing an older source does not make it fresh
- Paged responses preserve complete people and reference entries within a 24 KiB target. `limit` is an upper bound; `returnedCount` and `nextOffset` reflect the actual page. One complete person can exceed the target rather than lose credentials
- Paging offsets stop at 10,000; `atPagingCap` tells callers to narrow filters. Nested fields and enrichment carry the same values in text and structured output

### Source limitations

The FAA omits airmen who withhold address release. A missing record is not evidence that someone is unlicensed, and a matching record is not a current credential or operational-privilege determination. The dataset supplies no certificate numbers or recurrent-training currency. Medical dates and legacy instructor expiry fields do not establish medical fitness or instructor currency. Use the [FAA's official services](https://www.faa.gov/licenses_certificates/airmen_certification) for authoritative certification questions.

## Getting started

### Initialize the local snapshot

Install the package in an operator-owned directory so the compiled lifecycle CLI has a stable path:

```sh
bun add @cyanheads/faa-airmen-registry-mcp-server
export FAA_AIRMEN_MIRROR_DIR="$HOME/.local/share/faa-airmen-registry-mcp-server"
node node_modules/@cyanheads/faa-airmen-registry-mcp-server/dist/cli/mirror.js init
node node_modules/@cyanheads/faa-airmen-registry-mcp-server/dist/cli/mirror.js verify
```

The initial import downloads the complete FAA archive and needs time and disk space; it requires at least 1 GiB of free storage reserve before acquisition. Keep the same `FAA_AIRMEN_MIRROR_DIR` and location policy in the CLI and MCP client. Replace the illustrative `/absolute/path/to/airmen-mirror` below with that directory.

Run `refresh` explicitly when a newer snapshot is needed, and `status` to inspect readiness:

```sh
node node_modules/@cyanheads/faa-airmen-registry-mcp-server/dist/cli/mirror.js refresh
node node_modules/@cyanheads/faa-airmen-registry-mcp-server/dist/cli/mirror.js status
```

To retain city and ZIP, set `FAA_AIRMEN_INCLUDE_LOCATION=true` for both import and serving. Enabling it after an import that discarded those fields requires rebuilding through `refresh`. Disabling it suppresses location output and filtering immediately.

### Local MCP client

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

Or with Docker, initialize a persistent named volume first:

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

Use the same Docker command with `refresh`, `verify`, or `status` instead of `init` for maintenance. For local HTTP, publish only on loopback:

```sh
docker run --rm -p 127.0.0.1:3010:3010 -v faa-airmen-data:/data/airmen ghcr.io/cyanheads/faa-airmen-registry-mcp-server:latest
# Local MCP URL: http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher, or Node.js v24+
- Persistent local storage for the full snapshot; network access is needed only for operator initialization and refresh
- Node uses `better-sqlite3`, which ships prebuilt bindings for supported macOS, Linux, and Windows x64/arm64 targets without an install/postinstall compiler step. Execution has been tested on macOS with Node 24.22 and Bun; that does not establish execution on every packaged target

### Installation

```sh
git clone https://github.com/cyanheads/faa-airmen-registry-mcp-server.git
cd faa-airmen-registry-mcp-server
bun install
cp .env.example .env
bun run rebuild
node --env-file=.env dist/cli/mirror.js init
```

Set `FAA_AIRMEN_MIRROR_DIR` in `.env` to use an explicit directory; use the same value in the client. Node lifecycle commands need `--env-file=.env` or exported variables: the CLI does not load `.env` itself. The default directory is platform user-data storage independent of the working directory.

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FAA_AIRMEN_MIRROR_DIR` | Persistent operator-owned mirror directory; shared by CLI and server | Platform user-data directory plus `faa-airmen-registry-mcp-server` |
| `FAA_AIRMEN_INCLUDE_LOCATION` | `true` opts in to city/ZIP import, display, and filtering; `false` disables access | `false` |
| `FAA_AIRMEN_STALE_AFTER_DAYS` | Source-age warning threshold, integer 1–366; never a credential verdict | `45` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` | Bind address for local HTTP | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode; `.env.example` and Docker select stateless | `auto` (framework default) |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for common framework overrides. Framework storage settings do not relocate the FAA mirror.

## Running the server

### Local development

```sh
bun run rebuild
node --env-file=.env dist/cli/mirror.js init
bun run start:stdio
# Or local HTTP:
MCP_HTTP_HOST=127.0.0.1 bun run start:http
```

Run checks and tests:

```sh
bun run devcheck
bun run test
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Six read-only tools, shared schemas, and lossless rendering |
| `src/services/airmen` | FAA acquisition, streaming import, immutable mirror lifecycle, queries, and references |
| `src/cli` | Compiled operator lifecycle command |
| `src/config` | Server-specific environment parsing and validation |
| `tests/` | Synthetic source, lifecycle, query, and MCP contract tests |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Keep the operator-owned read-only FAA mirror in the service layer; use `ctx.state` only for tenant state
- Register tools in `createApp()` in `src/index.ts`
- Preserve source uncertainty, complete credentials, and text/structured parity; tests and examples use synthetic identities

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

# Snapshot lifecycle

A self-hosted server reads FAA airmen data from a local SQLite snapshot that the `faa-airmen-registry-mirror` CLI builds. The server never downloads data. The CLI and the server share `FAA_AIRMEN_MIRROR_DIR`; left unset, both use the platform user-data directory.

## Commands

| Command | What it does |
|:---|:---|
| `init` | Downloads the current FAA archive (about 57 MB) and builds a SQLite generation of about 1.75 GB; about 12 minutes in testing |
| `refresh` | Builds the next generation beside the current one (another ~1.75 GB). It never deletes old generations, since a running server may still be reading one |
| `verify` | Inspects the current generation's database and checks its row counts against the recorded metadata, listing any issues |
| `status` | Reports the snapshot state, including how many superseded generations there are and their size |
| `prune` | Deletes every generation `CURRENT` doesn't name, then prints what it removed and the bytes freed. Takes the writer lock and refuses unless the published snapshot is ready |

Run them as `npx -y --package @cyanheads/faa-airmen-registry-mcp-server faa-airmen-registry-mirror <command>`, as `node --env-file=.env dist/cli/mirror.js <command>` from a clone (the CLI doesn't load `.env` itself), or as `bun dist/cli/mirror.js <command>` inside the Docker image with the snapshot volume mounted at `/data/airmen`.

## Disk

Allow about 3 GB: one generation is about 1.75 GB, and the importer keeps a 1 GiB free-space reserve. Each `refresh` adds another generation until you `prune`.

## Pruning safely

Stop every server process (or container) that uses the mirror before running `prune`. Deleting a generation a server still has open can fail that server's lookups (Bun on macOS) or the deletion itself (Windows).

## City and ZIP

Street addresses are discarded before anything is stored. To keep city and ZIP, set `FAA_AIRMEN_INCLUDE_LOCATION=true` for both import and serving; a snapshot imported without it needs a `refresh` after enabling.

## Redaction

Output redaction (`FAA_AIRMEN_REDACT_PII`) is on by default and applies at serving time only; it never changes what the snapshot imports. A personal local install that wants the full surface (medical lookups, partial-name and city/ZIP searches, city and ZIP in output) sets `FAA_AIRMEN_REDACT_PII=false` on the server.

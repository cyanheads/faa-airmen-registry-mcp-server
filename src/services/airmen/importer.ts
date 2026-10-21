/**
 * @fileoverview Streaming ZIP/CSV import into an unpublished SQLite generation.
 * @module services/airmen/importer
 */
import { createHash } from 'node:crypto';
import { rm, statfs } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { defineMirror, type SqliteHandle, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { parse } from 'csv-parse';
import { type Entry, openPromise } from 'yauzl';
import type { ServerConfig } from '../../config/server-config.js';
import { MirrorError, safeMirrorError } from './mirror-error.js';
import { type AcquiredSource, SOURCE_PAGE } from './source.js';
import type { SnapshotDatabase, SnapshotMetadata, SourceFamily } from './types.js';

/** Increment when persisted schema or normalization policy changes. */
export const SCHEMA_VERSION = 1;
/** Reference vocabulary version stamped into each generation. */
export const REFERENCE_VERSION = 1;
const FILES = [
  'PILOT_BASIC.csv',
  'NONPILOT_BASIC.csv',
  'PILOT_CERT.csv',
  'NONPILOT_CERT.csv',
] as const;
const AUXILIARY = new Set(['HelpComm.pdf', 'HelpComm.txt', 'index_c.txt']);
const BASIC_HEADERS = [
  'UNIQUE ID',
  'FIRST NAME',
  'LAST NAME',
  'STREET 1',
  'STREET 2',
  'CITY',
  'STATE',
  'ZIP CODE',
  'COUNTRY',
  'REGION',
  'MED CLASS',
  'MED DATE',
  'MED EXP DATE',
  'BASIC MED COURSE DATE',
  'BASIC MED CMEC DATE',
  '',
];
const CERT_HEADERS = [
  'UNIQUE ID',
  'FIRST NAME',
  'LAST NAME',
  'TYPE',
  'LEVEL',
  'EXPIRE DATE',
  ...Array.from({ length: 11 }, (_, i) => `RATING${i + 1}`),
];
const RATING_CODES = new Set(
  'ADV|AIR|AIRCR|AIRFR|AIRPL|ALL|AME|AMEL|AMELC|AMES|ASE|ASEL|ASES|ASME|BACK|BAL|BASIC|CHEST|ENGINE|FAR|GL|GLAT|GLATGT|GLATSL|GLGT|GLGTSL|GLSL|GROUP I|GROUP II|GYRO|HEL|HELGY|INSPT|INST|INSTA|INSTH|INSTI|INSTP|JET|LAP|LTA|LTO|MAINT|METEOR|NAV|PLIFT|POWER|RADIO|RECIP|ROTOR|SEAT|SPORT|SPUR|TPROP'.split(
    '|',
  ),
);

async function reserve(directory: string): Promise<void> {
  const space = await statfs(directory);
  if (space.bavail * space.bsize < 1024 ** 3)
    throw new MirrorError('disk', 'Mirror import requires at least 1 GiB free storage reserve.');
}

/** Case-insensitive comparison key preserves punctuation and accents. */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toUpperCase();
}

const DDL = [
  'CREATE TABLE identity_variants (unique_id TEXT NOT NULL REFERENCES airmen(unique_id), family TEXT NOT NULL, origin TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, first_name_normalized TEXT NOT NULL, last_name_normalized TEXT NOT NULL, state TEXT, country TEXT, region TEXT, city TEXT, zip_code TEXT, tuple TEXT NOT NULL, PRIMARY KEY(unique_id,family,origin,tuple))',
  'CREATE INDEX identity_names ON identity_variants(last_name_normalized,first_name_normalized,unique_id)',
  'CREATE INDEX identity_state ON identity_variants(state,last_name_normalized,first_name_normalized,unique_id)',
  'CREATE TABLE certificates (record_id TEXT PRIMARY KEY, unique_id TEXT NOT NULL REFERENCES airmen(unique_id), first_name TEXT NOT NULL, last_name TEXT NOT NULL, type TEXT NOT NULL, level TEXT, legacy_expire_date_raw TEXT, source_families TEXT NOT NULL)',
  'CREATE INDEX certificates_person_type ON certificates(unique_id,type)',
  "CREATE TABLE ratings (record_id TEXT NOT NULL REFERENCES certificates(record_id), kind TEXT NOT NULL CHECK(kind IN ('rating','type_rating')), ordinal INTEGER NOT NULL, raw TEXT NOT NULL, level_code TEXT, code TEXT NOT NULL, PRIMARY KEY(record_id,kind,ordinal))",
  'CREATE INDEX ratings_code ON ratings(kind,code,record_id)',
  'CREATE TABLE medical_records (unique_id TEXT NOT NULL REFERENCES airmen(unique_id), source_families TEXT NOT NULL, med_class TEXT, med_date TEXT, med_exp_date TEXT, basicmed_course_date TEXT, basicmed_cmec_date TEXT, tuple TEXT NOT NULL, PRIMARY KEY(unique_id,tuple))',
  'CREATE TABLE snapshot_metadata (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)',
];

function families(existing: string, family: SourceFamily): string {
  const values: SourceFamily[] = JSON.parse(existing);
  if (!values.includes(family)) values.push(family);
  return JSON.stringify(values.sort((a, b) => (a === b ? 0 : a === 'pilot' ? -1 : 1)));
}

function count(db: SqliteHandle, table: string): number {
  return db.prepare<{ n: number }>(`SELECT count(*) n FROM ${table}`).get()?.n ?? 0;
}

/** Verify correspondence without FTS special INSERT commands (which write). */
export function inspectDatabase(db: SnapshotDatabase): {
  issues: string[];
  counts: SnapshotMetadata['counts'];
} {
  const issues: string[] = [];
  const checks = db.prepare<Record<string, string>>('PRAGMA integrity_check').all();
  if (checks.length !== 1 || Object.values(checks[0] ?? {})[0] !== 'ok')
    issues.push('sqlite_integrity');
  if (db.prepare('PRAGMA foreign_key_check').all().length) issues.push('foreign_keys');
  const counts = {
    airmen: db.prepare<{ n: number }>('SELECT count(*) n FROM airmen').get()?.n ?? 0,
    certificates: db.prepare<{ n: number }>('SELECT count(*) n FROM certificates').get()?.n ?? 0,
    ratings: db.prepare<{ n: number }>('SELECT count(*) n FROM ratings').get()?.n ?? 0,
    medicalRecords:
      db.prepare<{ n: number }>('SELECT count(*) n FROM medical_records').get()?.n ?? 0,
  };
  const fts = db.prepare<{ n: number }>('SELECT count(*) n FROM airmen_fts_docsize').get()?.n;
  if (
    fts !== counts.airmen ||
    db.prepare('SELECT rowid FROM airmen EXCEPT SELECT id FROM airmen_fts_docsize LIMIT 1').get() ||
    db.prepare('SELECT id FROM airmen_fts_docsize EXCEPT SELECT rowid FROM airmen LIMIT 1').get()
  )
    issues.push('fts_correspondence');
  if (
    db
      .prepare(
        'SELECT unique_id FROM airmen WHERE NOT EXISTS (SELECT 1 FROM certificates c WHERE c.unique_id=airmen.unique_id) LIMIT 1',
      )
      .get()
  )
    issues.push('airman_without_certificate');
  return { issues, counts };
}

/** Build and close a complete database; publication is owned by AirmenMirror. */
export async function importArchive(
  archive: string,
  databasePath: string,
  generationId: string,
  source: AcquiredSource,
  config: ServerConfig,
  clock: () => Date,
  signal: AbortSignal,
): Promise<SnapshotMetadata> {
  const zip = await openPromise(archive, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  }).catch((error: unknown) => {
    throw safeMirrorError(error, 'validation');
  });
  const store = sqliteMirrorStore({
    path: databasePath,
    table: 'airmen',
    primaryKey: 'unique_id',
    version: SCHEMA_VERSION,
    columns: {
      unique_id: 'TEXT',
      first_name: 'TEXT NOT NULL',
      last_name: 'TEXT NOT NULL',
      first_name_normalized: 'TEXT NOT NULL',
      last_name_normalized: 'TEXT NOT NULL',
      state: 'TEXT',
      country: 'TEXT',
      region: 'TEXT',
      city: 'TEXT',
      zip_code: 'TEXT',
      source_families: 'TEXT NOT NULL',
    },
    fts: ['first_name', 'last_name'],
    ftsTokenizer: 'unicode61 remove_diacritics 0',
    indexes: [
      { columns: ['last_name_normalized', 'first_name_normalized', 'unique_id'] },
      { columns: ['state', 'last_name_normalized', 'first_name_normalized', 'unique_id'] },
    ],
    migrations: [
      {
        version: 1,
        up(db) {
          for (const sql of DDL) db.exec(sql);
        },
      },
    ],
  });
  let journalClosed = false;
  try {
    if (zip.fileSize > 200 * 1024 * 1024 || zip.entryCount > 16)
      throw new MirrorError(
        'validation',
        'FAA archive exceeds its compressed-size or member-count limit.',
      );
    const entries = new Map<string, Entry>();
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (
        entries.size >= 16 ||
        entries.has(entry.fileName) ||
        entry.fileName.includes('/') ||
        entry.fileName.includes('\\') ||
        (!FILES.some((name) => name === entry.fileName) && !AUXILIARY.has(entry.fileName)) ||
        entry.isEncrypted() ||
        !entry.canDecodeFileData() ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
      ) {
        throw new MirrorError(
          'validation',
          'FAA archive contains an unexpected, unsafe, duplicate, or encrypted member.',
        );
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > 2 * 1024 ** 3)
        throw new MirrorError('validation', 'FAA archive exceeds the uncompressed size limit.');
      entries.set(entry.fileName, entry);
    }
    if (FILES.some((name) => !entries.has(name)))
      throw new MirrorError('validation', 'FAA archive is missing a required CSV member.');
    const db = await store.raw();
    const fileCounts: Record<string, number> = {};
    const warnings = { unknownCodes: 0, malformedDates: 0, malformedRatings: 0 };
    const insertPerson = db.prepare(
      'INSERT INTO airmen VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(unique_id) DO UPDATE SET source_families=excluded.source_families',
    );
    const getPerson = db.prepare<{ source_families: string }>(
      'SELECT source_families FROM airmen WHERE unique_id=?',
    );
    const insertVariant = db.prepare(
      'INSERT OR IGNORE INTO identity_variants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const insertMedical = db.prepare(
      'INSERT INTO medical_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(unique_id,tuple) DO UPDATE SET source_families=excluded.source_families',
    );
    const getMedical = db.prepare<{ source_families: string }>(
      'SELECT source_families FROM medical_records WHERE unique_id=? AND tuple=?',
    );
    const insertCert = db.prepare(
      'INSERT INTO certificates VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET source_families=excluded.source_families',
    );
    const getCert = db.prepare<{ source_families: string }>(
      'SELECT source_families FROM certificates WHERE record_id=?',
    );
    const insertRating = db.prepare('INSERT OR IGNORE INTO ratings VALUES (?,?,?,?,?,?)');
    const applyRow = (name: string, values: string[]) => {
      const family: SourceFamily = name.startsWith('PILOT_') ? 'pilot' : 'nonpilot';
      const id = values[0] ?? '';
      if (!/^[AC][0-9]{7}$/.test(id))
        throw new MirrorError('validation', 'FAA CSV contains an invalid Unique ID.');
      const first = values[1] ?? '';
      const last = values[2] ?? '';
      const person = getPerson.get(id);
      if (name.endsWith('_BASIC.csv')) {
        // Street columns never enter a domain tuple or SQL binding.
        const safe = [
          first,
          last,
          values[6] || null,
          values[8] || null,
          values[9] || null,
          config.includeLocation ? values[5] || null : null,
          config.includeLocation ? values[7] || null : null,
        ];
        const provenance = person
          ? families(person.source_families, family)
          : JSON.stringify([family]);
        insertPerson.run(
          id,
          first,
          last,
          normalizeName(first),
          normalizeName(last),
          safe[2] ?? null,
          safe[3] ?? null,
          safe[4] ?? null,
          safe[5] ?? null,
          safe[6] ?? null,
          provenance,
        );
        insertVariant.run(
          id,
          family,
          'basic',
          first,
          last,
          normalizeName(first),
          normalizeName(last),
          safe[2] ?? null,
          safe[3] ?? null,
          safe[4] ?? null,
          safe[5] ?? null,
          safe[6] ?? null,
          JSON.stringify(safe),
        );
        const medical = values.slice(10, 15);
        if (medical[0] && !['1', '2', '3'].includes(medical[0])) warnings.unknownCodes++;
        if (medical.some(Boolean)) {
          for (const [i, date] of medical.entries())
            if (
              i > 0 &&
              date &&
              !(
                i <= 2 ? /^(0[1-9]|1[0-2])\d{4}$/ : /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/
              ).test(date)
            )
              warnings.malformedDates++;
          const tuple = JSON.stringify(medical);
          const previous = getMedical.get(id, tuple);
          insertMedical.run(
            id,
            previous ? families(previous.source_families, family) : JSON.stringify([family]),
            ...medical.map((value) => value || null),
            tuple,
          );
        }
      } else {
        if (!person)
          throw new MirrorError(
            'validation',
            'FAA certificate references an ID absent from both BASIC files.',
          );
        const tuple = JSON.stringify([
          id,
          first,
          last,
          ...values.slice(3, 17),
          ...Array.from({ length: 99 }, (_, i) =>
            family === 'pilot' ? (values[i + 17] ?? '') : '',
          ),
        ]);
        const recordId = createHash('sha256')
          .update(generationId)
          .update('\0')
          .update(tuple)
          .digest('hex');
        const previous = getCert.get(recordId);
        const type = values[3] ?? '';
        if (!'PFAUGE HXMTRILWDNJ'.replaceAll(' ', '').includes(type) || type.length !== 1)
          warnings.unknownCodes++;
        if (values[5] && !/^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{4}$/.test(values[5]))
          warnings.malformedDates++;
        insertCert.run(
          recordId,
          id,
          first,
          last,
          type,
          values[4] || null,
          values[5] || null,
          previous ? families(previous.source_families, family) : JSON.stringify([family]),
        );
        insertVariant.run(
          id,
          family,
          'certificate',
          first,
          last,
          normalizeName(first),
          normalizeName(last),
          null,
          null,
          null,
          null,
          null,
          JSON.stringify([first, last]),
        );
        for (const kind of ['rating', 'type_rating'] as const) {
          const slots =
            kind === 'rating'
              ? values.slice(6, 17)
              : family === 'pilot'
                ? values.slice(17, 116)
                : [];
          for (const [index, raw] of slots.entries()) {
            if (!raw) continue;
            const slash = raw.indexOf('/');
            const level = slash > 0 ? raw.slice(0, slash).trim() : null;
            const code = slash >= 0 ? raw.slice(slash + 1).trim() : raw;
            if (slash !== 1 || !code) warnings.malformedRatings++;
            if (kind === 'rating' && !RATING_CODES.has(code)) warnings.unknownCodes++;
            insertRating.run(recordId, kind, index + 1, raw, level, code);
          }
        }
      }
    };
    const mirror = defineMirror({
      name: 'faa-airmen-registry',
      store,
      logger: {},
      async *sync() {
        for (const name of [...FILES, ...AUXILIARY].filter((name) => entries.has(name))) {
          const entry = entries.get(name);
          if (!entry) throw new Error('Missing checked member');
          const stream = await zip.openReadStreamPromise(entry);
          let checksum = 0;
          let size = 0;
          const checked = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              checksum = crc32(chunk, checksum);
              if (size > entry.uncompressedSize || size > 2 * 1024 ** 3)
                callback(new MirrorError('validation', 'FAA member exceeded its declared size.'));
              else callback(null, chunk);
            },
          });
          if (!name.endsWith('.csv')) {
            await pipeline(
              stream,
              checked,
              async (chunks) => {
                for await (const _chunk of chunks) {
                  signal.throwIfAborted();
                }
              },
              { signal },
            );
          } else {
            const expected = name.endsWith('_BASIC.csv')
              ? BASIC_HEADERS
              : [
                  ...CERT_HEADERS,
                  ...(name === 'PILOT_CERT.csv'
                    ? Array.from({ length: 99 }, (_, i) => `TYPERATING${i + 1}`)
                    : []),
                  '',
                ];
            const parser = parse({
              bom: true,
              trim: true,
              relax_quotes: true,
              skip_empty_lines: true,
              max_record_size: 64 * 1024,
            });
            let header = false;
            let rows = 0;
            let batch: string[][] = [];
            const consume = async (chunks: AsyncIterable<string[]>) => {
              for await (const values of chunks) {
                signal.throwIfAborted();
                if (!header) {
                  if (
                    values.length !== expected.length ||
                    values.some((value, i) => value !== expected[i])
                  )
                    throw new MirrorError(
                      'schema',
                      'FAA CSV required headers changed; update the importer before retrying.',
                    );
                  header = true;
                  continue;
                }
                if (values.length !== expected.length || values.at(-1) !== '')
                  throw new MirrorError(
                    'schema',
                    'FAA CSV row width or trailing field is invalid.',
                  );
                // Remove streets before retaining a row in a transaction batch.
                if (name.endsWith('_BASIC.csv')) {
                  values[3] = '';
                  values[4] = '';
                  if (!config.includeLocation) {
                    values[5] = '';
                    values[7] = '';
                  }
                }
                batch.push(values.map((value) => value.trim()));
                rows++;
                if (batch.length === 1000) {
                  await reserve(config.mirrorDir);
                  db.transaction(() => {
                    for (const row of batch) applyRow(name, row);
                  });
                  batch = [];
                }
              }
              await reserve(config.mirrorDir);
              db.transaction(() => {
                for (const row of batch) applyRow(name, row);
              });
            };
            await pipeline(stream, checked, parser, consume, { signal });
            if (!header || rows === 0)
              throw new MirrorError('validation', 'FAA required CSV is empty or incomplete.');
            fileCounts[name] = rows;
          }
          if (size !== entry.uncompressedSize || checksum !== entry.crc32)
            throw new MirrorError('validation', 'FAA ZIP member failed size or CRC validation.');
          yield { records: [] };
        }
      },
    });
    await mirror.runSync({ mode: 'init', signal });
    // Pick one whole BASIC variant deterministically, preserving every alternative.
    const pageIds = db.prepare<{ unique_id: string }>(
      'SELECT unique_id FROM airmen WHERE unique_id>? ORDER BY unique_id LIMIT 1000',
    );
    const choosePrimary = db.prepare(
      "UPDATE airmen SET (first_name,last_name,first_name_normalized,last_name_normalized,state,country,region,city,zip_code)=(SELECT first_name,last_name,first_name_normalized,last_name_normalized,state,country,region,city,zip_code FROM identity_variants v WHERE v.unique_id=airmen.unique_id AND origin='basic' ORDER BY CASE family WHEN 'pilot' THEN 0 ELSE 1 END,tuple LIMIT 1) WHERE unique_id=?",
    );
    let after = '';
    for (;;) {
      signal.throwIfAborted();
      const ids = pageIds.all(after);
      if (ids.length === 0) break;
      await reserve(config.mirrorDir);
      db.transaction(() => {
        for (const { unique_id } of ids) choosePrimary.run(unique_id);
      });
      after = ids.at(-1)?.unique_id ?? after;
      await setImmediate(undefined, { signal });
    }
    db.exec("INSERT INTO airmen_fts(airmen_fts) VALUES('integrity-check')");
    const inspection = inspectDatabase(db);
    if (inspection.issues.length || count(db, 'airmen') === 0)
      throw new MirrorError(
        'integrity',
        'FAA generation failed database or relationship validation.',
      );
    const metadata: SnapshotMetadata = {
      sourceName: 'FAA Releasable Airmen Database',
      sourcePageUrl: SOURCE_PAGE,
      ...source,
      importedAt: clock().toISOString(),
      generationId,
      schemaVersion: SCHEMA_VERSION,
      referenceVersion: REFERENCE_VERSION,
      includeLocation: config.includeLocation,
      complete: true,
      fileCounts,
      counts: inspection.counts,
      warnings,
    };
    db.prepare('INSERT INTO snapshot_metadata VALUES(1,?)').run(JSON.stringify(metadata));
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const journal = db.prepare<{ journal_mode: string }>('PRAGMA journal_mode=DELETE').get();
    if (journal?.journal_mode !== 'delete')
      throw new MirrorError('integrity', 'Staging database could not leave WAL mode.');
    journalClosed = true;
    return metadata;
  } catch (error) {
    throw safeMirrorError(error, 'validation');
  } finally {
    zip.close();
    await store.close();
    // Bun can leave an inert shared-memory file after a successful DELETE transition.
    // This unpublished generation has no other connections; no WAL is required now.
    if (journalClosed) await rm(`${databasePath}-shm`, { force: true });
  }
}

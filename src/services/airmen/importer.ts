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
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { parse } from 'csv-parse';
import { type Entry, openPromise } from 'yauzl';
import type { ServerConfig } from '../../config/server-config.js';
import { MirrorError, safeMirrorError } from './mirror-error.js';
import { FAA_SOURCE_URL, isDocumentedCode } from './reference.js';
import { type AcquiredSource, MAX_ARCHIVE } from './source.js';
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
/** Exact header row of each required CSV member; auxiliary members have none. */
const HEADERS = new Map<string, readonly string[]>([
  ['PILOT_BASIC.csv', BASIC_HEADERS],
  ['NONPILOT_BASIC.csv', BASIC_HEADERS],
  [
    'PILOT_CERT.csv',
    [...CERT_HEADERS, ...Array.from({ length: 99 }, (_, i) => `TYPERATING${i + 1}`), ''],
  ],
  ['NONPILOT_CERT.csv', [...CERT_HEADERS, '']],
]);
const MAX_MEMBERS = 16;
const MAX_UNCOMPRESSED = 2 * 1024 ** 3;
/** Source medical date shape (MMYYYY); other nonblank values are retained and counted malformed. */
export const MONTH_YEAR = /^(0[1-9]|1[0-2])\d{4}$/;
/** Source certificate expiry shape (MMDDYYYY). */
export const MONTH_DAY_YEAR = /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{4}$/;
/** Source BasicMed date shape (YYYYMMDD). */
export const YEAR_MONTH_DAY = /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/** A positional rating slot is well formed only when its first slash is at index 1 and a code follows. */
export function isMalformedSlot(raw: string, code: string): boolean {
  return raw.indexOf('/') !== 1 || !code;
}

/** Opaque FAA Unique ID: A or C plus seven digits. */
export const UNIQUE_ID = /^[AC][0-9]{7}$/;

/** Require the 1 GiB free-space reserve before writing more mirror data. */
export async function reserve(directory: string): Promise<void> {
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
  /**
   * Created before the last-name and state indexes: without sqlite_stat1, SQLite gives an
   * equal-cost tie to the most recently created index, so those keep two-name and state-bounded
   * searches. Generations imported without it remain readable at the same SCHEMA_VERSION.
   */
  'CREATE INDEX identity_first_names ON identity_variants(first_name_normalized,unique_id)',
  'CREATE INDEX identity_names ON identity_variants(last_name_normalized,first_name_normalized,unique_id)',
  'CREATE INDEX identity_state ON identity_variants(state,last_name_normalized,first_name_normalized,unique_id)',
  'CREATE TABLE certificates (record_id TEXT PRIMARY KEY, unique_id TEXT NOT NULL REFERENCES airmen(unique_id), first_name TEXT NOT NULL, last_name TEXT NOT NULL, type TEXT NOT NULL, level TEXT, legacy_expire_date_raw TEXT, source_families TEXT NOT NULL)',
  'CREATE INDEX certificates_person_type ON certificates(unique_id,type)',
  "CREATE TABLE ratings (record_id TEXT NOT NULL REFERENCES certificates(record_id), kind TEXT NOT NULL CHECK(kind IN ('rating','type_rating')), ordinal INTEGER NOT NULL, raw TEXT NOT NULL, level_code TEXT, code TEXT NOT NULL, PRIMARY KEY(record_id,kind,ordinal))",
  'CREATE INDEX ratings_code ON ratings(kind,code,record_id)',
  'CREATE TABLE medical_records (unique_id TEXT NOT NULL REFERENCES airmen(unique_id), source_families TEXT NOT NULL, med_class TEXT, med_date TEXT, med_exp_date TEXT, basicmed_course_date TEXT, basicmed_cmec_date TEXT, tuple TEXT NOT NULL, PRIMARY KEY(unique_id,tuple))',
  'CREATE TABLE snapshot_metadata (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)',
];

/** Add a family to a stored JSON family list, keeping pilot before nonpilot. */
function families(existing: string | undefined, family: SourceFamily): string {
  const values: SourceFamily[] = existing ? JSON.parse(existing) : [];
  if (!values.includes(family)) values.push(family);
  return JSON.stringify(values.sort((a, b) => (a === b ? 0 : a === 'pilot' ? -1 : 1)));
}

function count(db: SnapshotDatabase, table: string): number {
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
    airmen: count(db, 'airmen'),
    certificates: count(db, 'certificates'),
    ratings: count(db, 'ratings'),
    medicalRecords: count(db, 'medical_records'),
  };
  const fts = count(db, 'airmen_fts_docsize');
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
    throw signal.aborted ? error : safeMirrorError(error, 'validation');
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
    if (zip.fileSize > MAX_ARCHIVE || zip.entryCount > MAX_MEMBERS)
      throw new MirrorError(
        'validation',
        'FAA archive exceeds its compressed-size or member-count limit.',
      );
    const entries = new Map<string, Entry>();
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (
        entries.size >= MAX_MEMBERS ||
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
      if (totalBytes > MAX_UNCOMPRESSED)
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
      if (!UNIQUE_ID.test(id))
        throw new MirrorError('validation', 'FAA CSV contains an invalid Unique ID.');
      const first = values[1] ?? '';
      const last = values[2] ?? '';
      const nameColumns = [first, last, normalizeName(first), normalizeName(last)];
      const person = getPerson.get(id);
      if (name.endsWith('_BASIC.csv')) {
        // Street columns never enter a domain tuple or SQL binding.
        const location = [
          values[6] || null,
          values[8] || null,
          values[9] || null,
          config.includeLocation ? values[5] || null : null,
          config.includeLocation ? values[7] || null : null,
        ];
        insertPerson.run(
          id,
          ...nameColumns,
          ...location,
          families(person?.source_families, family),
        );
        insertVariant.run(
          id,
          family,
          'basic',
          ...nameColumns,
          ...location,
          JSON.stringify([first, last, ...location]),
        );
        const medical = values.slice(10, 15);
        if (medical[0] && !isDocumentedCode(medical[0], 'medical')) warnings.unknownCodes++;
        if (medical.some(Boolean)) {
          for (const [i, date] of medical.entries())
            if (i > 0 && date && !(i <= 2 ? MONTH_YEAR : YEAR_MONTH_DAY).test(date))
              warnings.malformedDates++;
          const tuple = JSON.stringify(medical);
          insertMedical.run(
            id,
            families(getMedical.get(id, tuple)?.source_families, family),
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
        if (!isDocumentedCode(type, 'type')) warnings.unknownCodes++;
        if (values[4] && !isDocumentedCode(values[4], 'level', type)) warnings.unknownCodes++;
        if (values[5] && !MONTH_DAY_YEAR.test(values[5])) warnings.malformedDates++;
        insertCert.run(
          recordId,
          id,
          first,
          last,
          type,
          values[4] || null,
          values[5] || null,
          families(previous?.source_families, family),
        );
        insertVariant.run(
          id,
          family,
          'certificate',
          ...nameColumns,
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
            if (isMalformedSlot(raw, code)) warnings.malformedRatings++;
            if (kind === 'rating' && !isDocumentedCode(code, 'rating')) warnings.unknownCodes++;
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
        for (const name of [...FILES, ...AUXILIARY]) {
          const entry = entries.get(name);
          if (!entry) continue;
          const stream = await zip.openReadStreamPromise(entry);
          let checksum = 0;
          let size = 0;
          const checked = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              checksum = crc32(chunk, checksum);
              if (size > entry.uncompressedSize || size > MAX_UNCOMPRESSED)
                callback(new MirrorError('validation', 'FAA member exceeded its declared size.'));
              else callback(null, chunk);
            },
          });
          const expected = HEADERS.get(name);
          if (!expected) {
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
            const flush = async () => {
              await reserve(config.mirrorDir);
              db.transaction(() => {
                for (const row of batch) applyRow(name, row);
              });
              batch = [];
            };
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
                if (batch.length === 1000) await flush();
              }
              await flush();
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
    if (inspection.issues.length || inspection.counts.airmen === 0)
      throw new MirrorError(
        'integrity',
        'FAA generation failed database or relationship validation.',
      );
    const metadata: SnapshotMetadata = {
      sourceName: 'FAA Releasable Airmen Database',
      sourcePageUrl: FAA_SOURCE_URL,
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
    // The signal's owner tells a cancellation from a deadline; an abort is never a validation failure.
    throw signal.aborted ? error : safeMirrorError(error, 'validation');
  } finally {
    zip.close();
    await store.close();
    // Bun can leave an inert shared-memory file after a successful DELETE transition.
    // This unpublished generation has no other connections; no WAL is required now.
    if (journalClosed) await rm(`${databasePath}-shm`, { force: true });
  }
}

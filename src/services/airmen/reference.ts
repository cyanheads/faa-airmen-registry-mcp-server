/**
 * @fileoverview FAA HelpComm January 2020 code tables, regulation-sourced additions, and sourced
 * interpretation guidance.
 * @module services/airmen/reference
 */
import type { Code, ReferenceEntry, ReferenceTopic } from './contracts.js';

/**
 * Canonical FAA publication page: it distributes HelpComm with the releasable archive and is the
 * only acquisition source, which operators cannot override.
 */
export const FAA_SOURCE_URL =
  'https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download';
const iacra = 'https://iacra.faa.gov/IACRA/newsevents.aspx';
const part61 =
  'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-D/part-61/subpart-A/section-61.5';
const part107 = [
  'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-107/subpart-B/section-107.12',
  'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-107/subpart-A/section-107.3',
];
const sourceUrls = [FAA_SOURCE_URL];
const revisionDate = '2026-10-20';
const revision = `FAA HelpComm, January 2020; packaged reference revision ${revisionDate}.`;
const packaged = `Packaged reference revision ${revisionDate}.`;
const types: Record<string, string> = {
  P: 'Pilot',
  F: 'Flight instructor',
  A: 'Authorized aircraft instructor',
  U: 'Remote pilot',
  G: 'Ground instructor',
  E: 'Flight engineer',
  H: 'Flight engineer (Special Purpose–Lessee)',
  X: 'Flight engineer (Foreign Based)',
  M: 'Mechanic',
  T: 'Control tower operator',
  R: 'Repairman',
  I: 'Repairman experimental aircraft builder',
  L: 'Repairman light sport aircraft',
  W: 'Parachute rigger',
  D: 'Dispatcher',
  N: 'Flight navigator',
  J: 'Flight navigator (Special Purpose–Lessee)',
};
const levels: Record<string, Record<string, string>> = {
  P: {
    A: 'Airline transport pilot',
    C: 'Commercial pilot',
    P: 'Private pilot',
    V: 'Recreational pilot',
    T: 'Sport pilot',
    S: 'Student pilot',
  },
  W: { U: 'Master parachute rigger', W: 'Senior parachute rigger' },
};
const ratings: Record<string, string> = {
  ADV: 'ADVANCED',
  AIR: 'LIGHTER-THAN-AIR AIRSHIP',
  AIRCR: 'AIRCRAFT',
  AIRFR: 'AIRFRAME',
  AIRPL: 'AIRPLANES',
  ALL: 'FEDERAL AVIATION ADMINISTRATION FLIGHT STANDARDS SERVICE INSPECTOR ALL RATINGS AUTHORIZED',
  AME: 'AIRPLANE MULTIENGINE',
  AMEL: 'AIRPLANE MULTIENGINE LAND',
  AMELC: 'AIRPLANE MULTIENGINE LAND LIMITED TO CENTER THRUST',
  AMES: 'AIRPLANE MULTIENGINE SEA',
  ASE: 'AIRPLANE SINGLE ENGINE',
  ASEL: 'AIRPLANE SINGLE ENGINE LAND',
  ASES: 'AIRPLANE SINGLE ENGINE SEA',
  ASME: 'AIRPLANE SINGLE AND MULTIENGINE',
  BACK: 'BACK',
  BAL: 'LIGHTER-THAN-AIR FREE BALLOON',
  BASIC: 'BASIC',
  CHEST: 'CHEST',
  ENGINE: 'AIRCRAFT ENGINE',
  FAR: 'FEDERAL AIR REGULATIONS',
  GL: 'GLIDER',
  GLAT: 'GLIDER AERO TOW',
  GLATGT: 'GLIDER AERO TOW AND GROUND TOW',
  GLATSL: 'GLIDER AERO TOW AND SELF LAUNCH',
  GLGT: 'GLIDER GROUND TOW',
  GLGTSL: 'GLIDER GROUND TOW AND SELF LAUNCH',
  GLSL: 'GLIDER SELF LAUNCH',
  'GROUP I': 'GROUP I',
  'GROUP II': 'GROUP II',
  GYRO: 'ROTORCRAFT-GYROPLANE',
  HEL: 'ROTORCRAFT-HELICOPTER',
  HELGY: 'ROTORCRAFT HELICOPTER AND GYROPLANE',
  INSPT: 'INSPECTION',
  INST: 'INSTRUMENT',
  INSTA: 'INSTRUMENT AIRPLANE',
  INSTH: 'INSTRUMENT HELICOPTER',
  INSTI: 'INSTRUMENT AIRPLANE AND HELICOPTER',
  INSTP: 'INSTRUMENT POWERED-LIFT',
  JET: 'TURBOJET POWERED',
  LAP: 'LAP',
  LTA: 'LIGHTER-THAN-AIR',
  LTO: 'LINK TRAINER OPERATOR',
  MAINT: 'MAINTENANCE',
  METEOR: 'METEOROLOGY',
  NAV: 'NAVIGATION',
  PLIFT: 'POWERED-LIFT',
  POWER: 'POWERPLANT',
  RADIO: 'RADIO NAVIGATION',
  RECIP: 'RECIPROCATING ENGINE POWERED',
  ROTOR: 'ROTORCRAFT',
  SEAT: 'SEAT',
  SPORT: 'SPORT',
  SPUR: 'SPECIAL PURPOSE',
  // Absent from HelpComm; the one rating 14 CFR Part 107 issues on every U certificate.
  SUAS: 'SMALL UNMANNED AIRCRAFT SYSTEM',
  TPROP: 'TURBOPROPELLER POWERED',
};
const cfii = 'CFII is INSTA, INSTH, INSTI, or INSTP on a flight instructor (F) certificate';
const mei = 'MEI is AME or ASME on F';
/** 14 CFR 61.5(c)–(d) instructor ratings and their FAA codes. */
const instructorGuidance = (note: string) => ({
  guidance: `${revision} ${note} (14 CFR 61.5(c)–(d)).`,
  sourceUrls: [FAA_SOURCE_URL, part61],
});
/** Sourced per-entry rating guidance; every other rating cites HelpComm alone. */
const ratingGuidance: Record<string, { guidance: string; sourceUrls: string[] }> = {
  ...Object.fromEntries(
    ['INSTA', 'INSTH', 'INSTI', 'INSTP'].map((code) => [
      code,
      instructorGuidance(`On F this is the instrument instructor rating; ${cfii}`),
    ]),
  ),
  ...Object.fromEntries(
    ['AME', 'ASME'].map((code) => [
      code,
      instructorGuidance(`On F this rating includes multiengine airplane instruction; ${mei}`),
    ]),
  ),
  ASE: instructorGuidance(`On F this is the single-engine airplane rating, not MEI; ${mei}`),
  ...Object.fromEntries(
    ['INST', 'ADV', 'BASIC'].map((code) => [
      code,
      instructorGuidance(`Occurs only on a ground instructor (G) certificate; ${cfii}`),
    ]),
  ),
  SUAS: {
    guidance: `Absent from FAA HelpComm; described from 14 CFR 107.12 and 107.3: Part 107 issues one rating, the small UAS rating, on the remote pilot (U) certificate. ${packaged}`,
    sourceUrls: part107,
  },
};
const obsolete = new Set(
  'AIRCR AIRPL ALL ENGINE FAR LTA LTO METEOR NAV RADIO ROTOR SPUR'.split(' '),
);
const medical: Record<string, string> = { '1': 'First', '2': 'Second', '3': 'Third' };
const codeTables = { type: types, rating: ratings, medical };

type CodeKind = keyof typeof codeTables | 'level';

function ownValue<T>(table: Record<string, T>, code: string): T | undefined {
  return Object.hasOwn(table, code) ? table[code] : undefined;
}
/** Levels are documented per certificate type; other kinds share one table. */
function tableFor(kind: CodeKind, certificateType = ''): Record<string, string> | undefined {
  return kind === 'level' ? ownValue(levels, certificateType) : codeTables[kind];
}

/** Description comparison key: case-insensitive, with underscore and space interchangeable. */
function descriptionKey(value: string): string {
  return value.replaceAll('_', ' ').replace(/\s+/gu, ' ').trim().toUpperCase();
}
const typesByDescription = new Map(
  Object.entries(types).map(([code, description]) => [descriptionKey(description), code]),
);
/** The certificate type letter whose documented description matches, if any. */
export function certificateTypeFor(value: string): string | undefined {
  return typesByDescription.get(descriptionKey(value));
}

/** Whether the packaged reference documents a type, level (per certificate type), rating, or medical class code. */
export function isDocumentedCode(code: string, kind: CodeKind, certificateType?: string): boolean {
  const table = tableFor(kind, certificateType);
  return Boolean(table && Object.hasOwn(table, code));
}

/** Describe only source-documented codes; unknown values remain unchanged. */
export function describeCode(code: string, kind: CodeKind, certificateType?: string): Code {
  const table = tableFor(kind, certificateType);
  const description = table && ownValue(table, code);
  return { code, ...(description ? { description } : {}) };
}
/** Add an obsolete marker only when the FAA table explicitly marks it. */
export function obsoleteRating(code: string): { obsolete?: boolean } {
  return obsolete.has(code) ? { obsolete: true } : {};
}
/** How identifier lookups narrow while serving-time personal-data redaction is on. */
const redactedIdentifiers =
  'Personal-data redaction is on: name searches require both lastName and firstName, or a Unique ID; nameMatch prefix and city or ZIP filters are rejected, city and ZIP are withheld, and faa_airmen_check_medical_status is unavailable. The operator turns it off with FAA_AIRMEN_REDACT_PII=false.';
/** Read packaged references without opening or initializing a mirror; `redacted` adds the redaction rule to identifiers. */
export function staticReference(topic: ReferenceTopic, redacted = false): ReferenceEntry[] {
  if (topic === 'certificate_types')
    return Object.entries(types).map(([code, description]) => ({
      code,
      description,
      guidance:
        code === 'F'
          ? `${revision} CFI certificates no longer expire under the December 2, 2024 rule; recent-experience requirements remain separate. Legacy expiry fields do not establish currency.`
          : revision,
      sourceUrls: code === 'F' ? [...sourceUrls, iacra] : sourceUrls,
    }));
  if (topic === 'certificate_levels')
    return Object.entries(levels).flatMap(([certificateType, values]) =>
      Object.entries(values).map(([code, description]) => ({
        code,
        description,
        certificateType,
        guidance: revision,
        sourceUrls,
      })),
    );
  if (topic === 'ratings')
    return Object.entries(ratings).map(([code, description]) => ({
      code,
      description,
      ...obsoleteRating(code),
      ...(ownValue(ratingGuidance, code) ?? { guidance: revision, sourceUrls }),
    }));
  if (topic === 'identifiers')
    return [
      {
        code: 'identifiers',
        guidance: `${revision} Unique IDs are opaque A or C plus seven digits, preserving leading zeros; they are not certificate numbers. Resolve names with faa_airmen_verify_certificate mode name; collisions remain separate people. FIRST NAME includes middle names and LAST NAME may include suffixes, so name searches match whole leading words by default: JOHN finds JOHN ROBERT and SMITH finds SMITH JR, while only a space separates words, so a hyphenated or apostrophe name is one word. nameMatch exact compares the whole field; prefix matches from its beginning, mid-word included. Address-withheld airmen are omitted, so absence does not establish lack of certification. City and ZIP require operator opt-in; street addresses are never stored. Initialize offline data with faa-airmen-registry-mirror init and replace it with faa-airmen-registry-mirror refresh.${redacted ? ` ${redactedIdentifiers}` : ''}`,
        sourceUrls,
      },
    ];
  if (topic === 'medical_guidance')
    return [
      {
        code: 'medical_guidance',
        guidance:
          'FAA medical fields are informational and are not authoritative evidence of medical certification, fitness, or eligibility to operate. Medical validity depends on class, age, and the operation; no individual expiry or eligibility is calculated. Raw medical dates are MMYYYY and BasicMed dates YYYYMMDD. BasicMed has separate medical examination, course, and operating requirements; consult current FAA guidance.',
        sourceUrls: [
          'https://www.faa.gov/ame_guide/app_process/general/validity',
          'https://www.faa.gov/licenses_certificates/airmen_certification/basic_med',
        ],
      },
    ];
  return [];
}

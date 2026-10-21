/**
 * @fileoverview FAA HelpComm January 2020 code tables and sourced interpretation guidance.
 * @module services/airmen/reference
 */
import type { Code, ReferenceEntry, ReferenceTopic } from './contracts.js';

/** Official source page distributing HelpComm with the releasable archive. */
export const FAA_SOURCE_URL =
  'https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download';
const iacra = 'https://iacra.faa.gov/IACRA/newsevents.aspx';
const sourceUrls = [FAA_SOURCE_URL];
const revision = 'FAA HelpComm, January 2020; packaged reference revision 2026-10-20.';
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
  TPROP: 'TURBOPROPELLER POWERED',
};
const obsolete = new Set(
  'AIRCR AIRPL ALL ENGINE FAR LTA LTO METEOR NAV RADIO ROTOR SPUR'.split(' '),
);
/** Describe only source-documented codes; unknown values remain unchanged. */
export function describeCode(
  code: string,
  kind: 'type' | 'rating' | 'medical' | 'level',
  certificateType?: string,
): Code {
  const description =
    kind === 'type'
      ? types[code]
      : kind === 'rating'
        ? ratings[code]
        : kind === 'medical'
          ? ({ '1': 'First', '2': 'Second', '3': 'Third' } as Record<string, string>)[code]
          : levels[certificateType ?? '']?.[code];
  return { code, ...(description ? { description } : {}) };
}
/** Add an obsolete marker only when the FAA table explicitly marks it. */
export function obsoleteRating(code: string): { obsolete?: boolean } {
  return obsolete.has(code) ? { obsolete: true } : {};
}
/** Read packaged references without opening or initializing a mirror. */
export function staticReference(topic: ReferenceTopic): ReferenceEntry[] {
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
      guidance: `${revision} CFII and MEI are not certificate types; search F certificates using the applicable FAA rating codes.`,
      sourceUrls,
    }));
  if (topic === 'identifiers')
    return [
      {
        code: 'identifiers',
        guidance: `${revision} Unique IDs are opaque A or C plus seven digits, preserving leading zeros; they are not certificate numbers. Resolve names with faa_airmen_verify_certificate mode name; collisions remain separate people. FIRST NAME includes middle names and LAST NAME may include suffixes. Address-withheld airmen are omitted, so absence does not establish lack of certification. City and ZIP require operator opt-in; street addresses are never stored. Initialize offline data with faa-airmen-registry-mirror init and replace it with faa-airmen-registry-mirror refresh.`,
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

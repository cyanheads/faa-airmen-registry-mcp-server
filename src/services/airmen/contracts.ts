/**
 * @fileoverview Public domain contracts for offline FAA registry queries.
 * @module services/airmen/contracts
 */
import type { Provenance, SourceFamily } from './types.js';

/** A documented code, or an unrecognized source code retained verbatim. */
export interface Code {
  code: string;
  description?: string;
}
/** Safe source identity projection; no street or medical fields. */
export interface Identity {
  city?: string;
  country?: string;
  firstName: string;
  lastName: string;
  region?: string;
  state?: string;
  zipCode?: string;
}
/** All distinct safe BASIC and certificate identity variants. */
export interface IdentityVariant extends Identity {
  origin: 'basic' | 'certificate';
  sourceFamily: SourceFamily;
}
/** One person joined strictly by the opaque FAA Unique ID. */
export interface Airman extends Identity {
  identityVariants?: IdentityVariant[];
  sourceFamilies: SourceFamily[];
  uniqueId: string;
}
/** One nonblank positional source rating. */
export interface Rating extends Code {
  levelCode?: string;
  obsolete?: boolean;
  ordinal: number;
  raw: string;
}
/** Complete certificate with all positional ratings retained. */
export interface Certificate {
  legacyExpireDateRaw?: string;
  level?: Code;
  ratings: Rating[];
  recordId: string;
  sourceFamilies: SourceFamily[];
  type: Code;
  typeRatings: Rating[];
}
/** Informational fields only; raw dates retain their source format. */
export interface MedicalRecord {
  basicMedCmecDateRaw?: string;
  basicMedCourseDateRaw?: string;
  medicalClass?: Code;
  medicalDateRaw?: string;
  medicalExpireDateRaw?: string;
  sourceFamilies: SourceFamily[];
}
/** Shared name/location inputs before semantic normalization. */
export interface NameInput {
  city?: string;
  firstName?: string;
  lastName?: string;
  nameMatch?: 'exact' | 'prefix';
  state?: string;
  zipCode?: string;
}
/** Flat public selector, validated into one unambiguous internal arm. */
export interface IdentityInput extends NameInput {
  mode: 'id' | 'name';
  uniqueId?: string;
}
/** Bounded person/reference pagination. */
export interface Paging {
  limit?: number;
  offset?: number;
}
/** General certificate lookup arguments. */
export interface VerifyInput extends IdentityInput, Paging {
  certificateType?: string;
}
/** Instructor search requires a name, location, or rating constraint. */
export interface InstructorInput extends NameInput, Paging {
  instructorType?: 'flight' | 'ground' | 'both';
  ratingCodes?: string[];
}
/** Reference vocabularies and operational guidance topics. */
export type ReferenceTopic =
  | 'certificate_types'
  | 'certificate_levels'
  | 'ratings'
  | 'type_ratings'
  | 'identifiers'
  | 'medical_guidance'
  | 'mirror_status';
/** Reference lookup arguments. */
export interface ReferenceInput extends Paging {
  filter?: string;
  topic: ReferenceTopic;
}
/** Sourced reference entry. */
export interface ReferenceEntry extends Code {
  certificateType?: string;
  guidance?: string;
  obsolete?: boolean;
  sourceUrls: string[];
}
/** Caller-visible diagnostic state without filesystem paths. */
export interface ReferenceMirrorStatus {
  lastRefreshFailure?: string;
  provenance?: Provenance;
  refreshState: 'idle' | 'running' | 'failed';
  state: 'missing' | 'ready' | 'unavailable';
}
/** Normalized filter values echoed independently from domain output. */
export type AppliedFilters = Record<string, string | number | string[]>;
/** Mandatory enrichment shared by every single lookup. */
export interface SingleEnrichment {
  appliedFilters: AppliedFilters;
  notice: string;
  provenance: Provenance | null;
}
/** Mandatory enrichment shared by every list, including empty pages. */
export interface ListEnrichment extends SingleEnrichment {
  atPagingCap: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  returnedCount: number;
  totalCount: number;
}
/** Tool handlers render data and write enrichment independently. */
export interface QueryResult<T, E extends SingleEnrichment = SingleEnrichment> {
  data: T;
  enrichment: E;
}
/** Complete person/certificate search results. */
export interface CertificateMatch {
  airman: Airman;
  certificates: Certificate[];
}
/** Complete qualifying instructor certificates. */
export interface InstructorMatch {
  airman: Airman;
  instructorCertificates: Certificate[];
}
/** Complete remote pilot certificates. */
export interface RemotePilotMatch {
  airman: Airman;
  remotePilotCertificates: Certificate[];
}
/** A missing identity is a successful lookup. */
export interface RatingsData {
  airman?: Airman;
  certificates?: Certificate[];
  found: boolean;
}
/** Medical absence remains distinct from person absence. */
export interface MedicalData {
  airman?: Airman;
  disclaimer: string;
  found: boolean;
  hasReportedMedicalFields?: boolean;
  medicalRecords?: MedicalRecord[];
}
/** Static and dynamic references share the same output shape. */
export interface ReferenceData {
  entries: ReferenceEntry[];
  mirrorStatus?: ReferenceMirrorStatus;
  topic: ReferenceTopic;
}

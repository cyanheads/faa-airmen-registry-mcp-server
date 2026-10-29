---
name: faa-airmen-registry-guide
description: Gates for faa_airmen_* lookups in the FAA releasable airmen snapshot. Covers turning CFII, MEI, ATP, and type-rating shorthand into codes, credentials with alternative codes, name matches that miss silently, reading a rating's own level, choosing the tool that returns a person's full certificate set, and wording a hit or a miss. Use when checking a pilot's, instructor's, or remote pilot's FAA certificates or ratings.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

These tools report what one monthly FAA releasable snapshot lists for a named person. They don't verify anything.

- Word findings as listings: "listed in the FAA releasable airmen snapshot for `<provenance.snapshotMonth>`", never "verified", "current", or "licensed". When `provenance.stale` is true, say the snapshot is older than the operator's freshness threshold.
- For an authoritative answer, such as a hiring, insurance, or legal decision or a miss the user disputes, point the user to the FAA's own airmen certification services (https://www.faa.gov/licenses_certificates/airmen_certification).
- The records carry names, state, region, country, certificate types and levels, ratings, type ratings, and a legacy expiry field. They carry no certificate number, date of birth, street address, certificate limitations, or flight-review or recurrent-training dates. If the user offers a certificate number, ask for the person's name.
- When responses carry `piiRedacted: true` (the public hosted instance does), this is a lookup for one fully named person, not a directory. Lists of instructors or remote pilots by state, rating, or partial name are refused, and so is medical data. Tell the user that rather than retrying with looser filters. Only the operator's setting changes it.

## Identifiers

- **Unique ID** (A or C plus seven digits) appears on every `airman` in the results of `faa_airmen_verify_certificate`, `faa_airmen_search_instructors`, and `faa_airmen_verify_remote_pilot`. Any of them feeds `faa_airmen_get_type_ratings`, `faa_airmen_check_medical_status`, or the `id` mode of either verify tool. Carry it forward instead of re-searching by name.
- **Codes** (certificate type and level letters, rating codes) come from `faa_airmen_list_reference`. **Type-rating designators** come from its `type_ratings` topic with a `filter` such as `737`. That list holds the designators observed in the snapshot and has no aircraft descriptions.

## Gates

### Translate shorthand before filtering

The filters accept a rating code or type designator the reference doesn't list. The call then matches nothing and returns zero results with no error, so a shorthand term reads like "doesn't hold it". Map first:

| User says | Send |
|:--|:--|
| CFI | `certificateType` `F`; the alias `CFI` is also accepted |
| CFII | any one of `INSTA`, `INSTH`, `INSTI`, `INSTP` on an F certificate (see the next gate) |
| MEI | `AME` or `ASME` on an F certificate (see the next gate) |
| Ground instructor advanced / instrument / basic | `ADV`, `INST`, `BASIC` on a G certificate |
| ATP | `certificateType` `P` with `certificateLevel` `A`; `certificateType` `ATP` is rejected |
| A 737 type rating | the exact designator from topic `type_ratings`: `B-737`, not `B737` |

A pilot's instrument rating is the same code on the P certificate (`C/INSTA` reads as instrument airplane at commercial level).

### One call ANDs its codes

All codes in one `ratingCodes` or `typeRatings` list must sit on the same certificate. A credential with alternative codes therefore takes one call per alternative. Check MEI as one call with `AME` and another with `ASME`, and CFII as up to four calls. Report a credential as unlisted only after every alternative returns zero.

### Name matching misses quietly

- Keep the default `words` match and pass the names as the user gives them. The FAA first-name field usually includes the middle name, so `exact` with a plain "First Last" misses nearly everyone. Use `exact` only with a value copied from a result.
- `words` matches whole leading words only. A partial word (`JOH`), a nickname (`BOB` for `ROBERT`), a middle name alone (someone who goes by it), or a middle initial against a full middle name returns nothing. Ask the user for the legal first and last name.
- Several candidates are several people. Narrow with `state` or the credential the user named, or ask the user for a detail that tells them apart. Never pick one and never merge them.

### Stop rule for a negative

Before saying a person lacks a credential:

1. Read the zero-result `notice`. On `faa_airmen_verify_certificate` it says how many people the name matched without the credential filters, which separates a name miss from a credential miss.
2. Confirm every code and designator against `faa_airmen_list_reference`.
3. Run every alternative code (previous gate).
4. Page to the end. Pages are cut to a size budget and can hold far fewer people than `limit`, so follow `nextOffset` while `hasMore` is true; a short page is not the last one.

Even then, report "not listed in this snapshot", never "does not hold".

### Read each rating at its own level

Every rating and type-rating slot has the raw form `level/code`, and the level belongs to that slot. On a pilot certificate it can differ from the certificate's level. An ATP (level `A`) certificate carrying `A/AMEL` and `C/ASEL` lists multiengine land at ATP level and single-engine land at commercial level. Report each rating with its own level. A level-qualified filter (`A/B-737`) matches only slots at that level, and `certificateLevel` constrains the certificate, not its slots.

### Use the tool that returns the whole record

- A person's complete credential set, pilot and non-pilot certificates alike, comes from `faa_airmen_verify_certificate` in `id` mode.
- `faa_airmen_get_type_ratings` returns only certificates from the FAA pilot files. It is empty for someone whose certificates are all non-pilot ones, such as ground instructor or mechanic.
- `faa_airmen_verify_remote_pilot` returns only remote pilot (U) certificates, and `faa_airmen_search_instructors` only the qualifying F and G certificates. When the question goes beyond what those tools cover, follow up in `id` mode.

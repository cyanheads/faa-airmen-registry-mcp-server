/** Synthetic FAA CSV/ZIP builders; no real registry records. */
import { crc32 } from 'node:zlib';

/** Build a BASIC record with explicit positional overrides. */
export function basicRow(id = 'A9999999', overrides: Record<number, string> = {}): string[] {
  const row = [
    id,
    'SYNTHETIC',
    'FIXTURE',
    'PRIVATE STREET SENTINEL',
    'PRIVATE UNIT SENTINEL',
    'TEST CITY SENTINEL',
    'WA',
    '99999',
    'USA',
    'NM',
    '',
    '',
    '',
    '',
    '',
    '',
  ];
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

/** Build a certificate record, retaining all eleven/ninety-nine positional slots. */
export function certificateRow(
  id = 'A9999999',
  pilot = true,
  overrides: Record<number, string> = {},
): string[] {
  const row = Array<string>(pilot ? 117 : 18).fill('');
  row.splice(0, 6, id, 'SYNTHETIC', 'FIXTURE', 'P', 'P', '');
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

const basicHeaders = [
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
const certHeaders = [
  'UNIQUE ID',
  'FIRST NAME',
  'LAST NAME',
  'TYPE',
  'LEVEL',
  'EXPIRE DATE',
  ...Array.from({ length: 11 }, (_, i) => `RATING${i + 1}`),
];

/** Encode real CSV quoting, including embedded quotes/newlines and BOM/CRLF. */
export function csv(rows: string[][]): string {
  return `\uFEFF${rows.map((row) => row.map((value) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join(',')).join('\r\n')}\r\n`;
}

/** Complete replacement source; each required family is nonempty. */
export function sourceFiles(
  options: {
    pilotBasic?: string[][];
    nonpilotBasic?: string[][];
    pilotCert?: string[][];
    nonpilotCert?: string[][];
  } = {},
): Record<string, string> {
  return {
    'PILOT_BASIC.csv': csv([basicHeaders, ...(options.pilotBasic ?? [basicRow()])]),
    'NONPILOT_BASIC.csv': csv([basicHeaders, ...(options.nonpilotBasic ?? [basicRow()])]),
    'PILOT_CERT.csv': csv([
      [...certHeaders, ...Array.from({ length: 99 }, (_, i) => `TYPERATING${i + 1}`), ''],
      ...(options.pilotCert ?? [certificateRow()]),
    ]),
    'NONPILOT_CERT.csv': csv([
      [...certHeaders, ''],
      ...(options.nonpilotCert ?? [certificateRow(undefined, false, { 3: 'U', 4: '' })]),
    ]),
  };
}

/** Produce a minimal stored ZIP with genuine CRC/central-directory metadata. */
export function zipSource(files = sourceFiles(), corruptCrc = false): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const checksum = crc32(data) ^ (corruptCrc ? 1 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum >>> 0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum >>> 0, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** Network boundary fake; rejects every URL outside the two expected requests. */
export function sourceFetch(archive: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('releasable_airmen_download'))
      return new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>');
    if (url === 'https://registry.faa.gov/CS102026.zip')
      return new Response(new Uint8Array(archive), {
        headers: { 'content-type': 'application/zip' },
      });
    throw new Error(`Unexpected synthetic fetch URL: ${url}`);
  }) as typeof fetch;
}

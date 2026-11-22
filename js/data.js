// Reading the fire-map bundle: the data contract of tools/fire_map/contract.py, on the page's side.
//
// Binary pack (*.bin.gz): gzip of  "FMAP" | u32 header length H | JSON header (padded so that 8 + H is a multiple of 8)
// | the columns in header order, little-endian, each padded to a multiple of 8 bytes. The header is
// {"v": 1, "kind", "shape", "columns": [{"name", "dtype"}], "meta"}. A host may already have decoded the gzip layer,
// so the gzip magic bytes (1f 8b) are checked first. Values: u16 65535 and u8 255 are "missing"; a chance is q / 65534;
// a scaled column is offset + q * scale; FWI is u8 0..250, 254 = day missing, 255 = no data.
//
// Unit-tested with `node --test tools/fire_map/jstest/` on files written by the Python side.

export const U16_MISSING = 65535;
export const CHANCE_STEPS = 65534;
export const FWI_MAX = 250;
export const FWI_DAY_MISSING = 254;
export const FWI_NO_DATA = 255;

const TYPES = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i16: Int16Array, i32: Int32Array, f32: Float32Array };
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The bytes as stored, gzip removed if it is still there. */
export async function maybeGunzip(bytes) {
  return isGzip(bytes) ? gunzip(bytes) : bytes;
}

/** {header, shape, columns: {name: TypedArray}} of an uncompressed pack; every length is checked. */
export function readPack(input) {
  if (!LITTLE_ENDIAN) throw new Error('this page needs a little-endian device');
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || bytes[0] !== 0x46 || bytes[1] !== 0x4d || bytes[2] !== 0x41 || bytes[3] !== 0x50) {
    throw new Error('not a fire-map pack (magic)');
  }
  if (bytes.byteOffset % 8 !== 0) bytes = bytes.slice(); // typed-array views need an aligned start
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  if ((8 + length) % 8 !== 0 || 8 + length > bytes.length) throw new Error('bad header length');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  if (header.v !== 1) throw new Error(`unknown pack version ${header.v}`);
  const count = header.shape.reduce((a, b) => a * b, 1);
  const columns = {};
  let offset = 8 + length;
  for (const column of header.columns) {
    const Type = TYPES[column.dtype];
    if (!Type) throw new Error(`unknown dtype ${column.dtype}`);
    const size = count * Type.BYTES_PER_ELEMENT;
    if (offset + size > bytes.length) throw new Error(`column ${column.name} runs past the end of the pack`);
    columns[column.name] = new Type(bytes.buffer, bytes.byteOffset + offset, count);
    offset += size + ((8 - (size % 8)) % 8);
  }
  if (offset !== bytes.length) throw new Error(`${bytes.length - offset} bytes after the last column`);
  return { header, shape: header.shape, columns };
}

// ---------------------------------------------------------------------------------------------------------------
// fetching (a fetch function can be passed for tests)
// ---------------------------------------------------------------------------------------------------------------
export async function fetchBytes(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadPack(url, fetchImpl) {
  return readPack(await maybeGunzip(await fetchBytes(url, fetchImpl)));
}

export async function loadJSON(url, fetchImpl) {
  const bytes = await maybeGunzip(await fetchBytes(url, fetchImpl));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A cache of promises by URL, so a file is fetched once however many layers ask for it. */
export class FileCache {
  constructor(base = '', fetchImpl = undefined) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.entries = new Map();
  }

  get(path, kind = path.endsWith('.bin.gz') ? 'pack' : 'json') {
    const key = `${kind}:${path}`;
    if (!this.entries.has(key)) {
      const url = this.base + path;
      const promise = kind === 'pack' ? loadPack(url, this.fetchImpl) : loadJSON(url, this.fetchImpl);
      promise.catch(() => this.entries.delete(key)); // a failed fetch can be tried again
      this.entries.set(key, promise);
    }
    return this.entries.get(key);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// value codes
// ---------------------------------------------------------------------------------------------------------------
export function chanceOf(q) {
  return q === U16_MISSING ? null : q / CHANCE_STEPS;
}

export function rankOf(q) {
  return q === U16_MISSING ? null : q;
}

/** A scaled condition value (u8 or u16 per the schema entry), or null when missing. */
export function scaledOf(q, entry) {
  return q === entry.missing ? null : entry.offset + q * entry.scale;
}

export function fwiOf(b) {
  return b <= FWI_MAX ? b : null;
}

export function fwiState(b) {
  if (b <= FWI_MAX) return 'value';
  return b === FWI_DAY_MISSING ? 'day_missing' : 'no_data';
}

/** The values of one row of a 2-d column [days][cells]. */
export function row(column, shape, index) {
  const width = shape[shape.length - 1];
  return column.subarray(index * width, (index + 1) * width);
}

// Pure functions of the fire-map page: the grid frame, dates, official classes and the EPSG:3978 projection.
// No DOM, no network: unit-tested with `node --test tools/fire_map/jstest/` against values computed by the Python side
// (tools/fire_map/contract.py, fm_logic.py, scripts/grid_common.py and pyproj).

// ---------------------------------------------------------------------------------------------------------------
// the 10 km grid frame (scripts/grid_common.py): grid_id = row * 1000 + col; frame left -2,340,000 m, top 2,810,000 m
// ---------------------------------------------------------------------------------------------------------------
export const GRID = Object.freeze({ ox: -2340000, oy: 2810000, cell: 10000, enc: 1000 });

export function rowCol(id) {
  return [Math.floor(id / GRID.enc), id % GRID.enc];
}

export function gridId(row, col) {
  if (row < 0 || col < 0 || col >= GRID.enc) throw new RangeError('row and col must be non-negative and col < 1000');
  return row * GRID.enc + col;
}

/** EPSG:3978 metres -> grid_id, -1 outside the frame (as grid_common.xy_to_gid). */
export function xyToGridId(x, y) {
  const col = Math.floor((x - GRID.ox) / GRID.cell);
  const row = Math.floor((GRID.oy - y) / GRID.cell);
  return col < 0 || col >= GRID.enc || row < 0 ? -1 : row * GRID.enc + col;
}

export function cellCentre(id) {
  const [row, col] = rowCol(id);
  return [GRID.ox + (col + 0.5) * GRID.cell, GRID.oy - (row + 0.5) * GRID.cell];
}

/** [[west, south], [east, north]] of a cell in EPSG:3978 metres. */
export function cellBounds(id) {
  const [row, col] = rowCol(id);
  const west = GRID.ox + col * GRID.cell;
  const north = GRID.oy - row * GRID.cell;
  return [[west, north - GRID.cell], [west + GRID.cell, north]];
}

/** Position of `id` in an ascending integer array (Uint32Array or Array), or -1. */
export function indexOf(sorted, id) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = sorted[mid];
    if (value === id) return mid;
    if (value < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// dates: ISO strings (YYYY-MM-DD) in UTC, so no time zone can shift a day
// ---------------------------------------------------------------------------------------------------------------
const DAY_MS = 86400000;

export function toDays(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function fromDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return fromDays(toDays(iso) + n);
}

export function dayDiff(a, b) {
  return toDays(a) - toDays(b);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekday(iso) {
  return (new Date(toDays(iso) * DAY_MS).getUTCDay() + 6) % 7;
}

/** The Monday on or before a day (weekly files start on it). */
export function weekStart(iso) {
  return addDays(iso, -weekday(iso));
}

/** The latest issue Monday on or before `day`, or null (`mondays` sorted ascending). */
export function activeMonday(day, mondays) {
  let best = null;
  for (const monday of mondays) {
    if (monday <= day) best = monday;
    else break;
  }
  return best;
}

/** The days a Monday's forecast covers: 1 to `horizon` days after it. */
export function windowOf(monday, horizon = 30) {
  return [addDays(monday, 1), addDays(monday, horizon)];
}

/** The issue Mondays whose window holds `day` (lead 1..horizon), ascending. */
export function coveringMondays(day, mondays, horizon = 30) {
  return mondays.filter((m) => {
    const lead = dayDiff(day, m);
    return lead >= 1 && lead <= horizon;
  });
}

export function daysBetween(first, last) {
  const out = [];
  for (let d = toDays(first); d <= toDays(last); d += 1) out.push(fromDays(d));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// official classes (legends.json): a class's upper bound is n.5, so whole values fall in the named ranges
// ---------------------------------------------------------------------------------------------------------------
/** Class index 0..4 of a value (the number of upper bounds at or below it); -1 for null or NaN. */
export function classOf(value, upperBounds) {
  if (value === null || value === undefined || Number.isNaN(value)) return -1;
  let k = 0;
  while (k < upperBounds.length && value >= upperBounds[k]) k += 1;
  return k;
}

export function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** The class whose colour is nearest to an RGB pixel of the official image (-1 when transparent). */
export function classOfColour(rgba, colours) {
  if (rgba[3] < 128) return -1;
  let best = -1;
  let bestDistance = Infinity;
  colours.forEach((hex, k) => {
    const [r, g, b] = hexToRgb(hex);
    const distance = (rgba[0] - r) ** 2 + (rgba[1] - g) ** 2 + (rgba[2] - b) ** 2;
    if (distance < bestDistance) {
      best = k;
      bestDistance = distance;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// EPSG:3978, NAD83 / Canada Atlas Lambert: +proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0
// +datum=NAD83 (GRS80). Ellipsoidal Lambert conformal conic with two standard parallels (Snyder 1987, eqs. 15-1 to
// 15-11 and 7-9 for the inverse latitude).
// ---------------------------------------------------------------------------------------------------------------
const RAD = Math.PI / 180;
const A = 6378137.0;
const FLAT = 1 / 298.257222101;
const E = Math.sqrt(FLAT * (2 - FLAT));

function mOf(phi) {
  const s = Math.sin(phi);
  return Math.cos(phi) / Math.sqrt(1 - E * E * s * s);
}

function tOf(phi) {
  const s = Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2);
}

const PHI1 = 49 * RAD;
const PHI2 = 77 * RAD;
const PHI0 = 49 * RAD;
const LAM0 = -95 * RAD;
const N = (Math.log(mOf(PHI1)) - Math.log(mOf(PHI2))) / (Math.log(tOf(PHI1)) - Math.log(tOf(PHI2)));
const F = mOf(PHI1) / (N * tOf(PHI1) ** N);
const RHO0 = A * F * tOf(PHI0) ** N;

/** [lon, lat] in degrees -> [x, y] in EPSG:3978 metres. */
export function lccForward(lon, lat) {
  const rho = A * F * tOf(lat * RAD) ** N;
  const theta = N * (lon * RAD - LAM0);
  return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)];
}

/** [x, y] in EPSG:3978 metres -> [lon, lat] in degrees. */
export function lccInverse(x, y) {
  const dy = RHO0 - y;
  const rho = Math.sign(N) * Math.sqrt(x * x + dy * dy);
  const theta = Math.atan2(Math.sign(N) * x, Math.sign(N) * dy);
  const t = (rho / (A * F)) ** (1 / N);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 15; i += 1) {
    const s = Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - E * s) / (1 + E * s)) ** (E / 2));
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }
  return [(theta / N + LAM0) / RAD, phi / RAD];
}

// ---------------------------------------------------------------------------------------------------------------
// numbers for people
// ---------------------------------------------------------------------------------------------------------------
/** A chance as a percentage with sensible precision: "0.4 %", "12 %", "under 0.1 %". */
export function percent(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return 'no forecast';
  const v = p * 100;
  if (v > 0 && v < 0.1) return 'under 0.1 %';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;
}

export function formatNumber(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

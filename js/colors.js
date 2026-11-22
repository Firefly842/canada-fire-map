// Colours of the fire map. The FWI layers use the official CWFIS classes and colours from legends.json; everything
// here is the page's own and was checked with the dataviz palette validator (scripts/validate_palette.js), all pairs,
// light and dark: caught/missed and natural/human pass every check (grey is the neutral "other"/"unknown" class).
// Human is purple (light #7b3294, dark #a958c8), so it is not read as the blue FWI class or the chance blues. Every dot
// has a ring: the surface colour on the plain map, a dark outline when a shading is on (app.js drawFires).
import { classOf, hexToRgb } from './lib.js';

// The chance of a fire in a zone within 30 days: one hue (blue), light to dark, on a log-like scale because most
// chances are small. In dark mode the ramp runs the other way, so "low" recedes into the dark map.
export const CHANCE_BREAKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.4];
export const CHANCE_LABELS = ['under 1 %', '1 to 2 %', '2 to 5 %', '5 to 10 %', '10 to 20 %', '20 to 40 %', '40 % or more'];
const BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

export function chanceColours(dark) {
  return dark ? [...BLUE].reverse() : BLUE;
}

export function chanceClass(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return -1;
  let k = 0;
  while (k < CHANCE_BREAKS.length && p >= CHANCE_BREAKS[k]) k += 1;
  return k;
}

// Fires: by the forecast's outcome (seasons with forecasts) or by cause.
export const FIRE_COLOURS = {
  light: { caught: '#1baf7a', missed: '#eb6834', other: '#8a8985', N: '#eb6834', H: '#7b3294', U: '#8a8985' },
  dark: { caught: '#199e70', missed: '#d95926', other: '#8d8c85', N: '#d95926', H: '#a958c8', U: '#8d8c85' },
};
export const OUTCOME_LABELS = {
  caught: 'caught: inside a zone marked on a Monday 1 to 30 days before it was reported',
  missed: 'missed: counted by the model, but in no zone marked 1 to 30 days before',
  other: 'not scored (under 1 ha, outside the scored area or the forecast weeks, or no match in the model\'s fire record)',
};
// "In the forecast's 30-day window": the colours follow the one forecast shown (the active Monday's marked zones)
export const WINDOW_OUTCOME_LABELS = {
  caught: 'caught by this forecast: inside one of its marked zones',
  missed: 'missed by this forecast: counted, but in none of its marked zones',
  other: OUTCOME_LABELS.other,
};
export const CAUSE_LABELS = { N: 'natural (mostly lightning)', H: 'human', U: 'unknown cause' };
export const CHANCE_TITLE = 'Chance that a fire of at least 1 ha is reported within 28 km in the next 30 days';
export const CHANCE_SHORT = ['<1', '1-2', '2-5', '5-10', '10-20', '20-40', '40+'];

export function isDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** An RGBA lookup table (256 entries x 4) for FWI codes 0..250 in the official classes; 254 and 255 transparent. */
export function fwiTable(legend) {
  const bounds = legend.codes.fwi.upper_bounds;
  const colours = legend.class_colours.map(hexToRgb);
  const table = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v <= 250; v += 1) {
    const [r, g, b] = colours[classOf(v, bounds)];
    table.set([r, g, b, 255], v * 4);
  }
  return table;
}

/** An RGBA lookup table for chance codes, indexed by class (0..6). */
export function chanceTable(dark) {
  return chanceColours(dark).map((hex) => [...hexToRgb(hex), 255]);
}

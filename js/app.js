// Canada fire map: the page. Reads the bundle under data/ (contract: tools/fire_map/contract.py) and draws it with
// Leaflet in a planar EPSG:3978 frame (map units are metres; latLng = [y, x]). Nothing is projected in the browser
// except the latitude/longitude readout (lib.js lccInverse).
import { FileCache, chanceOf, fwiOf, rankOf, scaledOf } from './data.js';
import {
  GRID, activeMonday, addDays, cellCentre, classOf, classOfColour, coveringMondays, dayDiff, daysBetween,
  formatNumber, indexOf, lccInverse, percent, toDays, weekStart, windowOf, xyToGridId,
} from './lib.js';
import {
  CAUSE_LABELS, CHANCE_LABELS, CHANCE_SHORT, CHANCE_TITLE, FIRE_COLOURS, OUTCOME_LABELS, WINDOW_OUTCOME_LABELS,
  chanceClass, chanceColours, chanceTable, fwiTable, isDark,
} from './colors.js';

const cache = new FileCache('data/');
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ll = (x, y) => L.latLng(y, x);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CODES = ['ffmc', 'dmc', 'dc', 'isi', 'bui', 'fwi'];
const RECORD_START = 1972;                    // first year of the fire history the model reads
const UNKNOWN_DAY = -1000000;                 // day number of a fire whose report date is unknown
const AGENCY_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', ON: 'Ontario', PC: 'Parks Canada', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const REASONS = {                             // J2's reasons why a counted fire is not drawn
  'no match in the open record': 'have no match in the national open fire record',
  'reported outside 1 April - 31 October': 'were reported outside 1 April to 31 October',
  'no usable location': 'have no usable location',
  'no longer in the open record': 'are no longer in the open record',
  'not in the current NFDB': 'are not in the current National Fire Database',
};
// Town labels: the capitals first, then by population; more of them as the map zooms in (non-capitals need at least
// this population at zooms below the given one), placed greedily without overlapping (M1 of the P3 review).
const CAPITALS = new Set(['Ottawa', 'Victoria', 'Edmonton', 'Regina', 'Winnipeg', 'Toronto', 'Québec', 'Fredericton',
  'Halifax', 'Charlottetown', "St. John's", 'Whitehorse', 'Yellowknife', 'Iqaluit']);
const LABEL_POPULATION = [[1, 1000000], [2, 200000]];
const LABEL_PAD = 4;                          // px between label boxes (and around the dots of labelled towns)

/** A percentage whose "%" never wraps onto a line of its own (O1 of the P3b review). */
const pct = (p) => percent(p).replace(/ %$/, ' %');

function agencyText(code) {
  return AGENCY_NAMES[code] ? `${AGENCY_NAMES[code]} (${code})` : String(code);
}

function andList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
/** "2025-11" -> "November 2025" */
function monthName(yearMonth) {
  return `${FULL_MONTHS[Number(yearMonth.slice(5, 7)) - 1]} ${yearMonth.slice(0, 4)}`;
}

/** The distinct "YYYY-MM" months of some ISO days, in order of first appearance. */
function monthsOf(days) {
  return [...new Set(days.map((day) => day.slice(0, 7)))];
}

function niceDate(iso, withDay = true) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
  return `${withDay ? `${weekday} ` : ''}${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------------------------------------------
// state: what is shown (also kept in the URL hash, so a view can be shared)
// ---------------------------------------------------------------------------------------------------------------
const state = {
  season: null, day: null, fires: true, zones: true, shade: 'none', period: 'day', window: '7d', colour: 'outcome',
  panel: null, playing: false, view: null,
};
const S = { seasons: {}, fires: {} };   // loaded documents

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('s')) state.season = p.get('s');
  if (p.has('d')) state.day = p.get('d');
  if (p.has('l')) {
    const layers = p.get('l').split(',');
    state.fires = layers.includes('fires');
    state.zones = layers.includes('zones');
  }
  for (const [key, name, allowed] of [['sh', 'shade', ['none', 'cwfis', 'model', 'chance']],
    ['per', 'period', ['day', 'mean7', 'max7']], ['w', 'window', ['day', '7d', 'window', 'season']],
    ['c', 'colour', ['outcome', 'cause']]]) {
    if (allowed.includes(p.get(key))) state[name] = p.get(key);
  }
  const panel = p.get('p');
  if (panel && /^(fire|cell):[A-Za-z0-9._-]+$/.test(panel)) {
    const [type, id] = panel.split(':');
    state.panel = { type, id };
  }
  // the map's view: zoom / centre x / centre y in km of the map frame (EPSG:3978), e.g. v=3/1150/-420
  const view = (p.get('v') || '').split('/').map(Number);
  if (view.length === 3 && view.every(Number.isFinite)) state.view = { z: view[0], x: view[1] * 1000, y: view[2] * 1000 };
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('s', state.season);
  p.set('d', state.day);
  p.set('l', [state.fires && 'fires', state.zones && 'zones'].filter(Boolean).join(','));
  p.set('sh', state.shade);
  if (state.shade === 'model') p.set('per', state.period);
  p.set('w', state.window);
  p.set('c', state.colour);
  if (state.panel) p.set('p', `${state.panel.type}:${state.panel.id}`);
  if (state.view) p.set('v', `${state.view.z}/${Math.round(state.view.x / 1000)}/${Math.round(state.view.y / 1000)}`);
  history.replaceState(null, '', `#${p.toString().replaceAll('%2F', '/')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// the map
// ---------------------------------------------------------------------------------------------------------------
const SCALE = 1 / 8192;                      // zoom 0: one screen pixel = 8 km
const CRS = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(SCALE, 0, -SCALE, 0) });
const map = L.map('map', {
  crs: CRS, minZoom: -1.5, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: true, preferCanvas: true,
});
for (const [name, z] of [['base', 300], ['raster', 340], ['lines', 380], ['zones', 420], ['fires', 450], ['select', 460],
  ['labels', 470]]) {
  const pane = map.createPane(name);
  pane.style.zIndex = String(z);
  if (['raster', 'lines', 'select', 'labels'].includes(name)) pane.style.pointerEvents = 'none';
}
map.attributionControl.setPrefix('<a href="https://leafletjs.com" rel="noopener" target="_blank">Leaflet</a>');
map.attributionControl.addAttribution('Data: NRCan, Statistics Canada, Natural Earth (<a href="#about" data-about="1">see About</a>)');
map.attributionControl.getContainer().addEventListener('click', (e) => {
  if (!e.target.closest('a[data-about]')) return;
  e.preventDefault();
  $('about').showModal();
});
L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
// the legend of the active shading, on the map (above the scale bar; above the bottom sheet on phones)
const MapLegend = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const box = L.DomUtil.create('div', 'map-legend');
    box.id = 'map-legend';
    box.hidden = true;
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  },
});
new MapLegend().addTo(map);
const zoneRenderer = L.canvas({ pane: 'zones', padding: 0.3 });
const fireRenderer = L.canvas({ pane: 'fires', padding: 0.3, tolerance: 3 });
map.fitBounds(L.latLngBounds(ll(-2300000, -700000), ll(3000000, 3900000)));

let baseLayers = [];
const zonesLayer = L.layerGroup().addTo(map);
const firesLayer = L.layerGroup().addTo(map);
let shade = { overlay: null, url: null, token: 0 };

function status(text) {
  const box = $('status');
  box.textContent = text || '';
  box.hidden = !text;
}

function drawBase() {
  for (const layer of baseLayers) layer.remove();
  baseLayers = [];
  const base = S.base;
  const coordsToLatLng = (c) => L.latLng(c[1], c[0]);
  const fills = L.geoJSON(base, {
    coordsToLatLng, pane: 'base', interactive: false,
    filter: (f) => ['province', 'land', 'neighbour'].includes(f.properties.kind),
    style: (f) => ({
      stroke: false, fillOpacity: 1,
      fillColor: f.properties.kind === 'neighbour' ? css('--neighbour') : css('--land'),
    }),
  });
  const lines = L.geoJSON(base, {
    coordsToLatLng, pane: 'lines', interactive: false,
    filter: (f) => ['province', 'land', 'lake', 'neighbour'].includes(f.properties.kind),
    style: (f) => (f.properties.kind === 'lake'
      ? { color: css('--land-line'), weight: 0.5, fillColor: css('--water'), fillOpacity: 1 }
      : { color: css('--land-line'), weight: f.properties.kind === 'neighbour' ? 0.5 : 0.8, fill: false }),
  });
  const dots = L.geoJSON(base, {
    coordsToLatLng, filter: (f) => f.properties.kind === 'town',
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      pane: 'labels', radius: 2.2, color: css('--text-2'), weight: 1, fillColor: css('--surface'), fillOpacity: 1,
      interactive: false,
    }),
  });
  const towns = base.features.filter((f) => f.properties.kind === 'town').map((f) => ({
    name: f.properties.name,
    population: f.properties.population || 0,
    capital: CAPITALS.has(f.properties.name),
    latlng: coordsToLatLng(f.geometry.coordinates),
  }));
  towns.sort((a, b) => (b.capital - a.capital) || (b.population - a.population) || a.name.localeCompare(b.name));
  const labels = L.layerGroup();
  townLabels = towns.map((town) => {
    const marker = L.marker(town.latlng, {
      pane: 'labels', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'town-anchor', iconSize: [0, 0], html: `<span class="town-label">${esc(town.name)}</span>` }),
    }).addTo(labels);
    return { ...town, marker, width: 0, height: 0 };
  });
  baseLayers = [fills.addTo(map), lines.addTo(map), dots.addTo(map), labels.addTo(map)];
  updateTownLabels();
}

let townLabels = [];
/** Show as many town labels as fit: by priority, each at the first of four places (right, left, above, below of its
 * dot) where its box, padded by LABEL_PAD, overlaps no label placed before it and no dot of a labelled town. */
function updateTownLabels() {
  const zoom = map.getZoom();
  const rule = LABEL_POPULATION.find(([below]) => zoom < below);
  const minimum = rule ? rule[1] : 0;
  const size = map.getSize();
  const taken = [];
  const free = (box) => taken.every((t) => box.x1 + LABEL_PAD <= t.x0 || t.x1 + LABEL_PAD <= box.x0
    || box.y1 + LABEL_PAD <= t.y0 || t.y1 + LABEL_PAD <= box.y0);
  for (const town of townLabels) {
    const el = town.marker.getElement() && town.marker.getElement().firstElementChild;
    if (!el) continue;
    el.classList.remove('shown');
    if (!town.capital && town.population < minimum) continue;
    const p = map.latLngToContainerPoint(town.latlng);
    if (p.x < -40 || p.y < -20 || p.x > size.x + 40 || p.y > size.y + 20) continue;
    if (!town.width) {
      town.width = Math.ceil(el.offsetWidth);
      town.height = Math.ceil(el.offsetHeight);
    }
    const w = town.width;
    const h = town.height;
    const dot = { x0: p.x - 3, y0: p.y - 3, x1: p.x + 3, y1: p.y + 3 };
    if (!free(dot)) continue;
    const places = [[5, -h / 2], [-5 - w, -h / 2], [-w / 2, -3 - h], [-w / 2, 3]];
    for (const [dx, dy] of places) {
      const box = { x0: p.x + dx, y0: p.y + dy, x1: p.x + dx + w, y1: p.y + dy + h };
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > size.x || box.y1 > size.y || !free(box)) continue;   // whole, not cut
      taken.push(box, dot);
      el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
      el.classList.add('shown');
      break;
    }
  }
  $('map').dataset.townLabels = String(document.querySelectorAll('.town-label.shown').length);   // read by the check
}
map.on('moveend resize', updateTownLabels);

// ---------------------------------------------------------------------------------------------------------------
// data of the season
// ---------------------------------------------------------------------------------------------------------------
const doc = () => S.seasons[state.season];
const seasonPath = (file) => `${state.season}/${file}`;
const gateOpen = () => doc().forecast_gate === 'open';

async function gridPack() {
  return cache.get('grid.bin.gz');
}

async function scoredCells() {
  return (await cache.get(seasonPath(doc().cells.file))).columns.grid_id;
}

function seasonDays() {
  return daysBetween(doc().days.first, doc().days.last);
}

async function loadSeason(season) {
  if (!S.seasons[season]) S.seasons[season] = await cache.get(`${season}/season.json`);
  if (!S.fires[season]) {
    const fires = await cache.get(`${season}/${S.seasons[season].fires.file}`);
    // a fire without a usable report date sorts before every day: it shows only under "season to date"
    fires.day = Int32Array.from(fires.columns.date, (d) => (d ? toDays(d) : UNKNOWN_DAY));
    fires.order = Array.from(fires.day.keys()).sort((a, b) => (fires.columns.size_ha[b] ?? 0) - (fires.columns.size_ha[a] ?? 0));
    if (fires.model) {
      fires.views = Array.from({ length: fires.n }, () => []);
      fires.model.fire.forEach((f, k) => fires.views[f].push(k));
    }
    S.fires[season] = fires;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// shading: one image overlay at a time
// ---------------------------------------------------------------------------------------------------------------
function gridBounds() {
  const g = S.grid;
  return L.latLngBounds(ll(g.ox, g.oy - g.nrow * g.cell_m), ll(g.ox + g.ncol * g.cell_m, g.oy));
}

function envelopeBounds() {
  const e = doc().fwi_cwfis.envelope;
  return L.latLngBounds(ll(e.x_min, e.y_min), ll(e.x_max, e.y_max));
}

function setOverlay(url, bounds, owned) {
  if (!shade.overlay) {
    shade.overlay = L.imageOverlay(url, bounds, { pane: 'raster', className: 'pixelated', opacity: 0.85, interactive: false }).addTo(map);
  } else {
    shade.overlay.setUrl(url);
    shade.overlay.setBounds(bounds);
  }
  if (shade.url) URL.revokeObjectURL(shade.url);
  shade.url = owned ? url : null;
}

function clearOverlay() {
  if (shade.overlay) shade.overlay.remove();
  if (shade.url) URL.revokeObjectURL(shade.url);
  shade = { overlay: null, url: null, token: shade.token };
}

/** Paint one pixel per cell (grid frame) and return an object URL of the PNG. */
function paintCells(ids, colourOf) {
  const { ncol, nrow } = S.grid;
  const canvas = document.createElement('canvas');
  canvas.width = ncol;
  canvas.height = nrow;
  const context = canvas.getContext('2d');
  const image = context.createImageData(ncol, nrow);
  const data = image.data;
  for (let i = 0; i < ids.length; i += 1) {
    const rgba = colourOf(i);
    if (!rgba) continue;
    const id = ids[i];
    const p = (Math.floor(id / GRID.enc) * ncol + (id % GRID.enc)) * 4;
    data[p] = rgba[0]; data[p + 1] = rgba[1]; data[p + 2] = rgba[2]; data[p + 3] = rgba[3];
  }
  context.putImageData(image, 0, 0);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png'));
}

/** The model's FWI per land cell (grid order) for the chosen day and period; NaN where there is none. */
async function modelFwi(day, period) {
  const n = S.grid.n_cells;
  const days = period === 'day' ? [day] : Array.from({ length: 7 }, (_, k) => addDays(day, k - 6));
  const sum = new Float64Array(n);
  const count = new Uint16Array(n);
  const best = new Float64Array(n).fill(-1);
  let present = 0;
  for (const d of days) {
    const week = weekStart(d);
    const file = doc().fwi_model.weeks[week];
    if (!file) continue;
    const pack = await cache.get(seasonPath(file));
    const k = dayDiff(d, week);
    const row = pack.columns.fwi.subarray(k * n, (k + 1) * n);
    if (row.length !== n || row[0] === 254 && row.every((v) => v === 254)) continue;
    present += 1;
    for (let i = 0; i < n; i += 1) {
      const v = fwiOf(row[i]);
      if (v === null) continue;
      sum[i] += v;
      count[i] += 1;
      if (v > best[i]) best[i] = v;
    }
  }
  const out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    if (count[i]) out[i] = period === 'max7' ? best[i] : sum[i] / count[i];
  }
  return { values: out, present };
}

async function drawShade() {
  const token = ++shade.token;
  const notes = [];
  if (state.shade === 'none') {
    clearOverlay();
  } else if (state.shade === 'cwfis') {
    const file = doc().fwi_cwfis.days[state.day];
    if (!file) {
      clearOverlay();
      notes.push('No official FWI map for this day.');
    } else {
      setOverlay(`data/${seasonPath(file)}`, envelopeBounds(), false);
    }
  } else if (state.shade === 'model') {
    const [{ values, present }, pack] = await Promise.all([modelFwi(state.day, state.period), gridPack()]);
    if (token !== shade.token) return;
    if (!present) {
      clearOverlay();
      notes.push(`No station weather for this day in the model's grid.${doc().fwi_cwfis.days[state.day]
        ? ' The official FWI map covers this day.' : ''}`);
    } else {
      const table = fwiTable(S.legends);
      const url = await paintCells(pack.columns.grid_id, (i) => (Number.isNaN(values[i]) ? null
        : table.subarray(Math.min(250, Math.round(values[i])) * 4, Math.min(250, Math.round(values[i])) * 4 + 4)));
      if (token !== shade.token) { URL.revokeObjectURL(url); return; }
      setOverlay(url, gridBounds(), true);
    }
  } else if (state.shade === 'chance') {
    const monday = activeMonday(state.day, doc().mondays);
    if (!gateOpen() || !monday) {
      clearOverlay();
      notes.push(gateOpen() ? 'No forecast Monday on or before this day.' : `The ${state.season} forecasts are not shown.`);
    } else {
      const [cells, forecast] = await Promise.all([scoredCells(), cache.get(seasonPath(doc().forecast.files[monday]))]);
      if (token !== shade.token) return;
      const table = chanceTable(isDark());
      const url = await paintCells(cells, (i) => {
        const k = chanceClass(chanceOf(forecast.columns.chance[i]));
        return k < 0 ? null : table[k];
      });
      if (token !== shade.token) { URL.revokeObjectURL(url); return; }
      setOverlay(url, gridBounds(), true);
    }
  }
  if (token === shade.token) status(notes.join(' '));
}

// ---------------------------------------------------------------------------------------------------------------
// marked zones and fires
// ---------------------------------------------------------------------------------------------------------------
function drawZones() {
  zonesLayer.clearLayers();
  if (!state.zones || !gateOpen()) return;
  const monday = activeMonday(state.day, doc().mondays);
  if (!monday) return;
  const halo = css('--zone-halo');
  const ink = css('--zone');
  for (const gid of doc().marked[monday] || []) {
    const [x, y] = cellCentre(gid);
    L.circle(ll(x, y), { radius: 28000, renderer: zoneRenderer, color: halo, weight: 4, opacity: 0.9, fill: false, interactive: false })
      .addTo(zonesLayer);
    L.circle(ll(x, y), { radius: 28000, renderer: zoneRenderer, color: ink, weight: 1.6, fill: true, fillOpacity: 0,
      bubblingMouseEvents: false }).on('click', () => openPanel({ type: 'cell', id: String(gid) })).addTo(zonesLayer);
  }
}

/** The fire's view (index into fires.model's rows) on one forecast Monday, or -1. */
function viewOn(fires, i, monday) {
  const m = fires.model;
  const k = fires.views[i].find((v) => m.mondays[m.monday[v]] === monday);
  return k === undefined ? -1 : k;
}

/** caught / missed / other. In the "forecast's 30-day window" view, by the marked zones of the forecast shown (the
 * active Monday); in the other views, by any forecast for a Monday 1 to 30 days before the report (M2 of the P3
 * review). Hindcasts are worded as forecasts "for" a Monday (MF1 of the P3c review). */
function fireOutcome(fires, i) {
  if (!fires.model) return null;
  const match = fires.columns.match ? fires.columns.match[i] : 'counted';
  if (!fires.columns.counted[i] || match !== 'counted' || !fires.model.eligible[i]) return 'other';
  if (state.window === 'window') {
    const monday = activeMonday(state.day, doc().mondays);
    const k = monday ? viewOn(fires, i, monday) : -1;
    if (k < 0) return 'other';
    return fires.model.marked[k] ? 'caught' : 'missed';
  }
  return fires.model.caught[i] ? 'caught' : 'missed';
}

function outcomeByWindow() {
  return state.window === 'window' && gateOpen();
}

function fireShown(fires, i) {
  const day = toDays(state.day);
  const known = !fires.columns.date_known || fires.columns.date_known[i];
  if (state.window === 'season') return fires.day[i] <= day;
  if (!known) return false;
  if (state.window === 'day') return fires.day[i] === day;
  if (state.window === '7d') return fires.day[i] > day - 7 && fires.day[i] <= day;
  const monday = gateOpen() ? activeMonday(state.day, doc().mondays) : null;
  if (!monday) return false;
  const [first, last] = windowOf(monday, doc().horizon_days);
  return fires.day[i] >= toDays(first) && fires.day[i] <= toDays(last);
}

function fireColour(fires, i) {
  const palette = FIRE_COLOURS[isDark() ? 'dark' : 'light'];
  if (state.colour === 'outcome' && fires.model) return palette[fireOutcome(fires, i)];
  return palette[fires.columns.cause[i]] || palette.U;
}

const fireRadius = (size) => Math.min(11, 3 + 1.6 * Math.log10(1 + Math.max(size ?? 0, 0)));

function drawFires() {
  firesLayer.clearLayers();
  if (!state.fires) return;
  const fires = S.fires[state.season];
  // a surface-coloured ring on the plain map; a dark outline over a shading, so no dot melts into it (S1)
  const ring = state.shade === 'none' ? css('--surface') : '#222222';
  let shown = 0;
  for (const i of fires.order) {
    if (!fireShown(fires, i)) continue;
    shown += 1;
    L.circleMarker(ll(fires.columns.x[i], fires.columns.y[i]), {
      renderer: fireRenderer, radius: fireRadius(fires.columns.size_ha[i]), color: ring, weight: 1.5,
      fillColor: fireColour(fires, i), fillOpacity: 0.95, bubblingMouseEvents: false,
    }).on('click', () => openPanel({ type: 'fire', id: fires.columns.id[i] })).addTo(firesLayer);
  }
  $('legend').dataset.firesShown = String(shown);
}

// the selected fire or place: a dark ring (light in dark mode) with a halo (S2)
const selectLayer = L.layerGroup().addTo(map);
function selectedPoint() {
  const target = state.panel;
  if (!target) return null;
  if (target.type === 'fire') {
    const fires = S.fires[state.season];
    const i = fires.columns.id.indexOf(target.id);
    return i < 0 ? null : { x: fires.columns.x[i], y: fires.columns.y[i], radius: fireRadius(fires.columns.size_ha[i]) };
  }
  const [x, y] = cellCentre(Number(target.id));
  return { x, y, cell: true };
}

function drawSelection() {
  selectLayer.clearLayers();
  const point = selectedPoint();
  if (!point) return;
  const ink = css('--select');
  const halo = css('--select-halo');
  const at = ll(point.x, point.y);
  if (point.cell) {
    const half = S.grid.cell_m / 2;
    const square = L.latLngBounds(ll(point.x - half, point.y - half), ll(point.x + half, point.y + half));
    for (const [color, weight] of [[halo, 5], [ink, 2]]) {
      L.rectangle(square, { pane: 'select', color, weight, fill: false, interactive: false }).addTo(selectLayer);
      L.circle(at, { pane: 'select', radius: 28000, color, weight, dashArray: color === ink ? '6 5' : null, fill: false,
        interactive: false }).addTo(selectLayer);
    }
  } else {
    for (const [color, weight] of [[halo, 5.5], [ink, 2.5]]) {
      L.circleMarker(at, { pane: 'select', radius: point.radius + 4, color, weight, fill: false, interactive: false })
        .addTo(selectLayer);
    }
  }
}

/** Pan the selected fire or place into the part of the map the panel does not cover (above the card on phones). */
function revealSelection() {
  const point = selectedPoint();
  const panel = $('panel');
  if (!point || panel.hidden) return;
  const box = map.getContainer().getBoundingClientRect();
  const card = panel.getBoundingClientRect();
  const size = map.getSize();
  const phone = card.left - box.left < 40;                 // the card spans the width: free area above it
  const free = phone ? { x0: 0, y0: 0, x1: size.x, y1: card.top - box.top }
    : { x0: 0, y0: 0, x1: card.left - box.left, y1: size.y };
  const p = map.latLngToContainerPoint(ll(point.x, point.y));
  const margin = 36;
  if (free.y1 - free.y0 < 2 * margin || free.x1 - free.x0 < 2 * margin) return;
  if (p.x >= free.x0 + margin && p.x <= free.x1 - margin && p.y >= free.y0 + margin && p.y <= free.y1 - margin) return;
  map.panBy([p.x - (free.x0 + free.x1) / 2, p.y - (free.y0 + free.y1) / 2], { animate: false });
}

// ---------------------------------------------------------------------------------------------------------------
// legend
// ---------------------------------------------------------------------------------------------------------------
function drawLegend() {
  const items = [];
  const fires = S.fires[state.season];
  if (state.fires) {
    const palette = FIRE_COLOURS[isDark() ? 'dark' : 'light'];
    const shown = $('legend').dataset.firesShown || '0';
    items.push(`<div class="muted">Fires shown: ${formatNumber(Number(shown))} (dot size grows with reported fire size)</div>`);
    const byOutcome = state.colour === 'outcome' && fires.model;
    const monday = byOutcome && outcomeByWindow() ? activeMonday(state.day, doc().mondays) : null;
    const labels = byOutcome ? (monday ? WINDOW_OUTCOME_LABELS : OUTCOME_LABELS) : CAUSE_LABELS;
    if (byOutcome) {
      items.push(`<div class="muted">${monday ? `Colours follow the forecast shown, for ${esc(niceDate(monday))}.`
        : 'Colours follow every forecast for a Monday 1 to 30 days before each report.'}</div>`);
    }
    for (const [key, label] of Object.entries(labels)) {
      items.push(`<div class="item"><span class="dot" style="background:${palette[key]}"></span>${esc(label)}</div>`);
    }
    const source = doc().fires && doc().fires.source;
    if (source === 'nfdb') {
      items.push('<div class="credit">Fires: Canadian National Fire Database, Natural Resources Canada (Open Government '
        + 'Licence - Canada). Its records are not complete or free of error, and locations are approximate.</div>');
    } else if (source === 'nrcan_reported_fires') {
      items.push('<div class="credit">Fires: Agency Reported Wildfires in Canada, Natural Resources Canada (Open '
        + 'Government Licence - Canada). Locations are approximate, as the agencies reported them.</div>');
    }
  }
  if (state.zones && gateOpen()) {
    items.push('<div class="item"><span class="ring"></span>marked zone (28 km radius): one of the 200 the model marks each Monday</div>');
  }
  if (state.shade === 'cwfis' || state.shade === 'model') {
    const what = state.shade === 'cwfis' ? 'Fire Weather Index, official map' : `Fire Weather Index, model grid (${$('model-period').selectedOptions[0].text})`;
    items.push(`<div class="muted">${esc(what)}</div>`);
    S.legends.class_colours.forEach((colour, k) => {
      items.push(`<div class="item"><span class="swatch" style="background:${colour}"></span>FWI ${esc(S.legends.codes.fwi.ranges[k])}</div>`);
    });
    items.push(state.shade === 'cwfis'
      ? '<div class="credit">Fire Weather Index map: Canadian Forest Service, Canadian Wildland Fire Information System '
        + '(CWFIS), Natural Resources Canada. The images are the CWFIS map service\'s own rendering, re-hosted by this '
        + 'project. Contains information licensed under the Open Government Licence - Canada.</div>'
      : '<div class="credit">The model\'s 10 km grid: values estimated for each cell from CWFIS weather-station records '
        + '(Natural Resources Canada); close to the official map but not identical.</div>');
  }
  if (state.shade === 'chance' && gateOpen()) {
    items.push(`<div class="muted">${esc(CHANCE_TITLE)}</div>`);
    chanceColours(isDark()).forEach((colour, k) => {
      items.push(`<div class="item"><span class="swatch" style="background:${colour}"></span>${CHANCE_LABELS[k]}</div>`);
    });
  }
  $('legend').innerHTML = items.join('') || '<div class="muted">No layer is on.</div>';
  drawMapLegend();
}

/** The compact legend of the active shading on the map (M4); hidden when no shading is on. */
function drawMapLegend() {
  const box = $('map-legend');
  let title = '';
  let colours = [];
  let names = [];
  if (state.shade === 'cwfis' || state.shade === 'model') {
    title = state.shade === 'cwfis' ? 'Fire Weather Index (FWI): official CWFIS map, re‑hosted'
      : `Fire Weather Index (FWI): model's 10 km grid, ${$('model-period').selectedOptions[0].text}`;
    colours = S.legends.class_colours;
    names = S.legends.codes.fwi.ranges;
  } else if (state.shade === 'chance' && gateOpen()) {
    title = `${CHANCE_TITLE} (%)`;
    colours = chanceColours(isDark());
    names = CHANCE_SHORT;
  }
  box.hidden = !title;
  if (!title) { box.innerHTML = ''; return; }
  const cells = colours.map((colour, k) => `<span class="step"><span class="bar" style="background:${colour}"></span>`
    + `<span class="name">${esc(names[k])}</span></span>`).join('');
  box.innerHTML = `<div class="title">${esc(title)}</div><div class="steps">${cells}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------
// time control
// ---------------------------------------------------------------------------------------------------------------
function drawTimeControl() {
  const days = seasonDays();
  const slider = $('day');
  slider.max = String(days.length - 1);
  slider.value = String(Math.max(0, days.indexOf(state.day)));
  $('date-label').textContent = niceDate(state.day);
  const ticks = $('ticks');
  const position = (iso) => `${(100 * dayDiff(iso, days[0])) / Math.max(days.length - 1, 1)}%`;
  const monday = gateOpen() ? activeMonday(state.day, doc().mondays) : null;
  let html = doc().mondays.map((m) => `<span class="${m === monday ? 'active' : ''}" style="left:${position(m)}"></span>`).join('');
  if (monday) {
    const [first, last] = windowOf(monday, doc().horizon_days);
    const end = last > days[days.length - 1] ? days[days.length - 1] : last;
    html += `<div class="window" style="left:${position(first)};width:calc(${position(end)} - ${position(first)})"></div>`;
  }
  ticks.innerHTML = html;
  let label = '';
  if (!gateOpen()) {
    label = 'No forecasts are shown for this season.';
  } else if (monday) {
    const [first, last] = windowOf(monday, doc().horizon_days);
    label = `Forecast for ${niceDate(monday)}; it covers ${niceDate(first, false)} to ${niceDate(last, false)}.`;
  } else {
    label = `The first forecast is for ${niceDate(doc().mondays[0])}.`;
  }
  $('forecast-label').textContent = label;
}

function setDay(day) {
  const days = seasonDays();
  state.day = days.includes(day) ? day : days[Math.min(Math.max(0, dayDiff(day, days[0])), days.length - 1)];
  refresh();
}

function step(n) {
  const days = seasonDays();
  const k = days.indexOf(state.day) + n;
  if (k < 0 || k >= days.length) return false;
  setDay(days[k]);
  return true;
}

function jumpMonday(direction) {
  const mondays = doc().mondays;
  const target = direction > 0 ? mondays.find((m) => m > state.day) : [...mondays].reverse().find((m) => m < state.day);
  if (target) setDay(target);
}

let timer = null;
function play(on) {
  state.playing = on;
  $('play').textContent = on ? 'Pause' : 'Play';
  clearInterval(timer);
  if (on) {
    timer = setInterval(() => {
      if (!step(1)) play(false);
      prefetch();
    }, 700);
  }
}

function prefetch() {
  const next = addDays(state.day, 1);
  if (state.shade === 'cwfis' && doc().fwi_cwfis.days[next]) new Image().src = `data/${seasonPath(doc().fwi_cwfis.days[next])}`;
  if (state.shade === 'model') {
    const file = doc().fwi_model.weeks[weekStart(addDays(state.day, 7))];
    if (file) cache.get(seasonPath(file)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the info panel
// ---------------------------------------------------------------------------------------------------------------
function chip(code, value) {
  if (!CODES.includes(code) || value === null || value === undefined) return '';
  const legend = S.legends.codes[code];
  const k = classOf(value, legend.upper_bounds);
  return k < 0 ? '' : `<span class="chip" title="official class ${esc(legend.ranges[k])}" style="background:${S.legends.class_colours[k]}"></span>`;
}

function valueText(entry, value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    if (entry.name === 'own_fires_last5') return '<span class="muted">blank: a year without an agency record</span>';
    return '<span class="muted">no value</span>';
  }
  if (entry.name === 'fuel_type_majority') return esc(S.legends.fuel[String(Math.round(value))] || `code ${Math.round(value)}`);
  if (entry.name === 'years_since_last_fire' && value > Number(state.season) - RECORD_START) {
    return `none since ${RECORD_START}`;
  }
  return `${chip(entry.name, value)}${formatNumber(value, entry.decimals)}${entry.unit ? ` ${esc(entry.unit)}` : ''}`;
}

/** Label and value rows; both panels use the same wide label column, and long text values wrap (S4). */
function conditionsTable(schema, valueOf) {
  const rows = schema.map((entry) => {
    const value = valueOf(entry);
    const text = value === null || value === undefined || Number.isNaN(value) || entry.name === 'fuel_type_majority'
      || (entry.name === 'years_since_last_fire' && value > Number(state.season) - RECORD_START);
    return `<tr><td>${esc(entry.label)}</td><td class="${text ? 'val' : 'num'}">${valueText(entry, value)}</td></tr>`;
  });
  return `<table class="cond"><tbody>${rows.join('')}</tbody></table>`;
}

/** The agency's own fire number from our id ("NT-2026-EV009-26" -> "EV009-26"), else the id. */
function fireNumber(id) {
  const match = /^(?:NFDB-)?[A-Z]{2}-\d{4}-(.+)$/.exec(id);
  return match ? match[1] : id;
}

function placeText(x, y) {
  const [lon, lat] = lccInverse(x, y);
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** Whether a rank is better (smaller) than the worst rank among the Monday's marked zones. The picker takes zones in
 * rank order and skips one whose centre is within 56 km of a zone already marked, so such an unmarked zone was skipped
 * by the spacing rule. Reads that Monday's forecast file (cached). */
async function rankedAboveMarked(monday, rank) {
  const marked = (doc().marked || {})[monday] || [];
  const file = doc().forecast && doc().forecast.files[monday];
  if (!marked.length || !file) return false;
  const [cells, forecast] = await Promise.all([scoredCells(), cache.get(seasonPath(file))]);
  let worst = 0;
  for (const gid of marked) {
    const k = indexOf(cells, gid);
    if (k >= 0) worst = Math.max(worst, rankOf(forecast.columns.rank[k]));
  }
  return rank < worst;
}

async function fireHtml(id) {
  const fires = S.fires[state.season];
  const i = fires.columns.id.indexOf(id);
  if (i < 0) return null;
  const c = fires.columns;
  const known = !c.date_known || c.date_known[i];
  const size = c.size_ha[i];
  const rows = [
    ['Reported', known ? niceDate(c.date[i]) : 'report date unknown'],
    ['Size', size === null || size < 0 ? 'not reported' : `${formatNumber(size, size < 10 ? 1 : 0)} ha`],
    ['Cause', CAUSE_LABELS[c.cause[i]] || 'unknown'],
  ];
  if (c.status) rows.push(['Stage of control', c.status[i]]);
  if (c.response) rows.push(['Response', c.response[i]]);
  if (c.attack_date) rows.push(['Attack date', c.attack_date[i] ? niceDate(c.attack_date[i]) : '—']);
  if (c.out_date) rows.push(['Out date', c.out_date[i] ? niceDate(c.out_date[i]) : '—']);
  rows.push(['Location', placeText(c.x[i], c.y[i])]);
  const counted = c.counted[i] ? 'yes' : (c.match && c.match[i] === 'no_match' ? 'no: no match in the model\'s fire record' : 'no: under 1 ha');
  rows.push(['Counted by the model', counted]);
  let html = `<p class="subtitle">${esc(agencyText(c.agency[i]))}</p>`;
  html += `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  if (fires.conditions) {
    html += `<h4>Conditions in its 10 km cell on the report day</h4>`;
    html += conditionsTable(fires.conditions.schema, (entry) => fires.conditions.values[entry.name][i]);
  }
  if (fires.model) {
    const views = fires.views[i];
    html += '<h4>Forecasts for the Mondays before its report</h4>';
    if (!views.length) {
      html += '<p class="muted">No forecast Monday in the 30 days before its report covered it.</p>';
    } else {
      const m = fires.model;
      const shown = activeMonday(state.day, doc().mondays);
      html += `<table><thead><tr><th>Forecast Monday</th><th class="num">Chance</th><th class="num">Rank (of ${formatNumber(doc().cells.n)})</th>`
        + '<th>Marked</th></tr></thead><tbody>';
      html += views.map((k) => `<tr${m.mondays[m.monday[k]] === shown ? ' class="active" title="the forecast shown on the map"' : ''}>`
        + `<td>${esc(niceDate(m.mondays[m.monday[k]], false))}</td><td class="num">${pct(m.chance[k])}</td>`
        + `<td class="num">${formatNumber(m.rank[k])}</td><td>${m.marked[k] ? 'yes' : 'no'}</td></tr>`).join('');
      html += '</tbody></table>';
      if (views.some((k) => m.mondays[m.monday[k]] === shown)) html += '<p class="hint">In bold: the forecast shown on the map.</p>';
      // name the forecasts that caught it; in the window view, whether the one shown did (O2 of the P3b review)
      const by = views.filter((k) => m.marked[k]).map((k) => niceDate(m.mondays[m.monday[k]], false).replace(/ \d{4}$/, ''));
      const onShown = views.find((k) => m.mondays[m.monday[k]] === shown);
      // S7 of the P3c review: the bold row ranked above that Monday's worst-ranked marked zone but was not marked
      if (onShown !== undefined && !m.marked[onShown] && await rankedAboveMarked(shown, m.rank[onShown])) {
        html += '<p class="hint">Ranked high but not marked: a zone within 56 km was marked first (the spacing rule).</p>';
      }
      const shownNote = outcomeByWindow() && onShown !== undefined
        ? (m.marked[onShown] ? ', including the one shown' : ', not by the one shown') : '';
      const verdict = m.caught[i] ? `<b>Caught</b> by the ${esc(andList(by))} forecast${by.length > 1 ? 's' : ''}`
        + `${shownNote}: a zone marked beforehand contained it.` : '<b>Not caught</b>: no zone marked beforehand contained it.';
      html += `<p>${verdict}</p>`;
    }
  } else if (!gateOpen()) {
    html += `<p class="muted">The model's forecasts for ${esc(state.season)} are not shown.</p>`;
  }
  return { title: `Fire ${fireNumber(id)}`, html };
}

async function cellHtml(gid) {
  const pack = await gridPack();
  const position = indexOf(pack.columns.grid_id, gid);
  if (position < 0) return null;
  const [x, y] = cellCentre(gid);
  const g = S.grid.codes;
  let html = `<dl class="kv"><dt>Place</dt><dd>${esc(placeText(x, y))}</dd></dl>`;
  html += '<h4>About this place <span class="muted">(not used by the model)</span></h4>';
  html += `<dl class="kv"><dt>Agency</dt><dd>${esc(agencyText(g.region[pack.columns.region[position]]))}</dd>`
    + `<dt>Ecozone</dt><dd>${esc(g.ecozone[pack.columns.ecozone[position]])}</dd></dl>`;
  const { values, present } = await modelFwi(state.day, 'day');
  html += '<h4>Fire Weather Index on this day</h4>';
  const fwi = present ? values[position] : NaN;
  html += `<p>Model's 10 km grid: ${Number.isNaN(fwi) ? '<span class="muted">no value</span>' : `${chip('fwi', fwi)}${formatNumber(fwi)}`}`;
  const official = await officialClass(x, y);
  if (official !== null) html += `; official map: ${official}`;
  html += '</p>';
  const monday = activeMonday(state.day, doc().mondays);
  if (!monday) {
    html += '<p class="muted">No forecast Monday on or before this day.</p>';
    return { title: 'Place', html };
  }
  const cells = await scoredCells();
  const k = indexOf(cells, gid);
  if (k < 0) {
    html += '<p class="muted">This place is not scored this season (no usable fire record for its area).</p>';
    return { title: 'Place', html };
  }
  if (gateOpen()) {
    const f = (await cache.get(seasonPath(doc().forecast.files[monday]))).columns;
    const marked = (doc().marked[monday] || []).includes(gid);
    html += `<h4>Forecast for ${esc(niceDate(monday))}</h4>`;
    html += `<p class="lead"><b>${pct(chanceOf(f.chance[k]))}</b>: ${esc(CHANCE_TITLE.charAt(0).toLowerCase() + CHANCE_TITLE.slice(1))}.</p>`;
    html += `<dl class="kv"><dt>Rank</dt><dd>${formatNumber(rankOf(f.rank[k]))} of ${formatNumber(cells.length)}</dd>`
      + `<dt>Marked</dt><dd>${marked ? 'yes, one of the 200 zones' : 'no'}</dd>`
      + `<dt>The three parts of the model</dt><dd>tree ${pct(chanceOf(f.tree[k]))}, small network ${pct(chanceOf(f.mlp[k]))}, `
      + `large network ${pct(chanceOf(f.xl[k]))}</dd></dl>`;
  } else {
    html += `<p class="muted">The model's forecasts for ${esc(state.season)} are not shown.</p>`;
  }
  const conditions = doc().conditions;
  if (conditions && conditions.files[monday]) {
    const c = (await cache.get(seasonPath(conditions.files[monday]))).columns;
    html += `<h4>The model's inputs on ${esc(niceDate(monday))}</h4>`;
    html += conditionsTable(conditions.schema, (entry) => scaledOf(c[entry.name][k], entry));
  }
  if (gateOpen()) html += fireListHtml(x, y, monday);
  return { title: 'Place', html };
}

function fireListHtml(x, y, monday) {
  const fires = S.fires[state.season];
  const [first, last] = windowOf(monday, doc().horizon_days);
  const lo = toDays(first);
  const hi = toDays(last);
  const near = [];
  for (let i = 0; i < fires.n; i += 1) {
    if (fires.day[i] < lo || fires.day[i] > hi || !fires.columns.counted[i]) continue;
    const dx = fires.columns.x[i] - x;
    const dy = fires.columns.y[i] - y;
    if (dx * dx + dy * dy <= 28000 * 28000) near.push(i);
  }
  let html = `<h4>Counted fires reported in this zone, ${esc(niceDate(first, false))} to ${esc(niceDate(last, false))}</h4>`;
  if (!near.length) return `${html}<p class="muted">None.</p>`;
  return `${html}<table><tbody>${near.map((i) => `<tr><td>${esc(fires.columns.id[i])}</td><td>${esc(niceDate(fires.columns.date[i], false))}</td>`
    + `<td class="num">${formatNumber(fires.columns.size_ha[i], 1)} ha</td></tr>`).join('')}</tbody></table>`;
}

const imageCache = new Map();
async function officialClass(x, y) {
  if (state.shade !== 'cwfis') return null;
  const file = doc().fwi_cwfis.days[state.day];
  if (!file) return 'no map this day';
  const e = doc().fwi_cwfis.envelope;
  if (!imageCache.has(file)) {
    imageCache.set(file, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        resolve(context);
      };
      image.onerror = reject;
      image.src = `data/${seasonPath(file)}`;
    }));
  }
  const context = await imageCache.get(file);
  const px = Math.floor(((x - e.x_min) / (e.x_max - e.x_min)) * context.canvas.width);
  const py = Math.floor(((e.y_max - y) / (e.y_max - e.y_min)) * context.canvas.height);
  if (px < 0 || py < 0 || px >= context.canvas.width || py >= context.canvas.height) return 'outside the map';
  const k = classOfColour(context.getImageData(px, py, 1, 1).data, S.legends.class_colours);
  return k < 0 ? 'no value' : `FWI ${S.legends.codes.fwi.ranges[k]}`;
}

let revealed = '';                              // the target last panned into view, so a refresh does not pan again
async function openPanel(target) {
  state.panel = target;
  writeHash();
  drawSelection();
  const content = target.type === 'fire' ? await fireHtml(target.id) : await cellHtml(Number(target.id));
  if (state.panel !== target) return;
  if (!content) { closePanel(); return; }
  $('panel-title').textContent = content.title;
  $('panel-body').innerHTML = content.html;
  $('panel').hidden = false;
  const key = `${state.season}:${target.type}:${target.id}`;
  if (key !== revealed) {
    revealed = key;
    revealSelection();
  }
}

function closePanel() {
  state.panel = null;
  revealed = '';
  $('panel').hidden = true;
  drawSelection();
  writeHash();
}

map.on('click', async (event) => {
  const x = event.latlng.lng;
  const y = event.latlng.lat;
  const gid = xyToGridId(x, y);
  const pack = await gridPack();
  if (gid >= 0 && indexOf(pack.columns.grid_id, gid) >= 0) openPanel({ type: 'cell', id: String(gid) });
  else closePanel();
});

// ---------------------------------------------------------------------------------------------------------------
// the About panel's season part: every number comes from season.json, which the build made from its reports
// ---------------------------------------------------------------------------------------------------------------
function fillAbout() {
  const d = doc();
  const n = d.notes || {};
  const season = state.season;
  const open = gateOpen();
  if (open && d.counts) {
    const could = d.counts.fires_that_could_be_caught;
    const caught = d.counts.fires_caught;
    // the season's caveat from the build; a hindcast note only repeats "Official information" below, so its word goes
    // into the sentence (the sidebar shows the full note under the season)
    const note = d.model && d.model.note ? d.model.note : '';
    const hindcasts = /hindcast/i.test(note);
    $('about-results').textContent = `In ${season}, ${hindcasts ? 'the hindcasts' : 'the forecasts'} could catch `
      + `${formatNumber(could)} counted fires: those reported within 28 km of a scored place, 1 to 30 days after a `
      + `forecast Monday. ${formatNumber(caught)} of them (${(100 * caught / could).toFixed(1)} %) were inside a marked `
      + `zone.${note && !hindcasts ? ` ${note}` : ''}`;
  } else {
    $('about-results').textContent = open ? '' : `The model's ${season} forecasts are not shown on this map.`;
  }
  $('about-season-name').textContent = season;
  const notes = [];
  if (n.counted_not_drawn > 0) {
    const reasonAgencies = n.counted_not_drawn_by_reason_agency || {};
    const reasons = Object.entries(n.counted_not_drawn_by_reason || {}).map(([why, k]) => {
      const only = Object.keys(reasonAgencies[why] || {});
      const where = only.length === 1 ? ` (all in ${AGENCY_NAMES[only[0]] || only[0]})` : '';
      return `${formatNumber(k)}${where} ${REASONS[why] || why}`;
    });
    // O4 of the P3c review: say when none of them is in the score (the agency list made room for it)
    const outOfScore = open && d.counts && !(n.eligible_not_drawn > 0) ? ' None of them is in the score above.' : '';
    notes.push(`${formatNumber(n.counted_not_drawn)} of the ${formatNumber(n.counted_total)} counted fires are not drawn`
      + `${reasons.length ? `: ${andList(reasons)}` : ''}.${outOfScore}`);
  }
  if (n.eligible_not_drawn > 0 && open && d.counts) {
    // their report dates come from the build (season.json notes), so the reason is stated only when the dates show it
    const dates = n.eligible_not_drawn_dates || [];
    const after = dates.length === n.eligible_not_drawn && dates.every((day) => day > d.days.last);
    const reported = monthsOf(dates);
    const covering = monthsOf(dates.flatMap((day) => coveringMondays(day, d.mondays, d.horizon_days)));
    const forecast = covering.length === 1 ? `${/^(Apr|Aug|Oct)/.test(monthName(covering[0])) ? 'an' : 'a'} `
      + `${monthName(covering[0]).split(' ')[0]} forecast` : 'a forecast Monday';
    notes.push(`${formatNumber(n.eligible_not_drawn)} of the ${formatNumber(d.counts.fires_that_could_be_caught)} fires in `
      + `the score above (${formatNumber(n.caught_not_drawn)} of them caught) are among them`
      + `${after ? `: they were reported ${reported.length === 1 ? `in ${monthName(reported[0])}`
        : `after ${niceDate(d.days.last, false)}`}, after the map's last day but within 30 days of ${forecast}` : ''}.`);
  }
  if (n.dates_repaired > 0) {
    const resets = n.reset_latest_by_agency || {};
    const where = Object.keys(resets).map((a) => AGENCY_NAMES[a] || a);
    const reset = Object.values(resets).reduce((sum, k) => sum + k, 0) || n.dates_repaired;
    notes.push(`The open record later reset the report date of ${formatNumber(reset)}`
      + `${where.length ? ` ${andList(where)}` : ''} fires to 1 January ${season}; `
      + `${reset === n.dates_repaired ? 'for all of them' : `for ${formatNumber(n.dates_repaired)} of them`} the map uses `
      + 'the date of an earlier version.');
  }
  if (n.date_unknown > 0) {
    notes.push(`${formatNumber(n.date_unknown)} ${n.date_unknown === 1 ? 'fire has no usable report date and appears'
      : 'fires have no usable report date and appear'} only under "season to date".`);
  }
  if (n.no_longer_in_record > 0) {
    notes.push(`${formatNumber(n.no_longer_in_record)} fires withdrawn from the open record are not drawn.`);
  }
  if (n.fwi_model_last_reported_day && n.fwi_model_last_reported_day < `${season}-10-31`) {
    notes.push(`Station weather ends on ${niceDate(n.fwi_model_last_reported_day)}: after it, the model's FWI grid and `
      + 'the fires\' report-day conditions are empty.');
  }
  if ((n.fwi_cwfis_days_missing || []).length) {
    notes.push(`The official FWI map could not be obtained for ${andList(n.fwi_cwfis_days_missing.map((day) => niceDate(day)))}.`);
  }
  if (Number(season) >= 2026) {
    notes.push('The model\'s 2026 "fires nearby" inputs are counts from the Canadian Interagency Forest Fire '
      + 'Centre\'s daily situation reports.');
  }
  $('about-notes').innerHTML = notes.map((text) => `<li>${esc(text)}</li>`).join('') || '<li>None.</li>';
  $('about-build').textContent = `Data bundle ${S.manifest.bundle_id}, built ${S.manifest.build_utc.slice(0, 10)}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// controls and refresh
// ---------------------------------------------------------------------------------------------------------------
function syncControls() {
  $('season').value = state.season;
  $('layer-fires').checked = state.fires;
  $('layer-zones').checked = state.zones;
  $('fire-window').value = state.window;
  $('fire-colour').value = state.colour;
  $('model-period').value = state.period;
  document.querySelectorAll('input[name="shade"]').forEach((input) => { input.checked = input.value === state.shade; });
  const open = gateOpen();
  $('layer-zones').disabled = !open;
  $('shade-chance').disabled = !open;
  $('fire-window').querySelector('option[value="window"]').disabled = !open;
  $('fire-colour').querySelector('option[value="outcome"]').disabled = !S.fires[state.season].model;
  const note = $('gate-note');
  note.hidden = open;
  note.textContent = open ? '' : `The model's forecasts for ${state.season} are not shown on this map. Fires and the Fire Weather Index are.`;
  // the model in words (season.json "model", from the build): its label, and with the forecasts shown its caveat (M3)
  $('season-note').textContent = doc().model ? doc().model.label : '';
  $('season-caveat').textContent = open && doc().model && doc().model.note ? doc().model.note : '';
  $('season-caveat').hidden = !$('season-caveat').textContent;
  $('drawer-summary').textContent = `${niceDate(state.day)} · ${state.season}`;
  fillAbout();
}

let refreshing = Promise.resolve();
function refresh() {
  if (!gateOpen()) {
    if (state.shade === 'chance') state.shade = 'none';
    if (state.window === 'window') state.window = '7d';
  }
  if (state.colour === 'outcome' && !S.fires[state.season].model) state.colour = 'cause';
  syncControls();
  drawTimeControl();
  drawZones();
  drawFires();
  drawSelection();
  drawLegend();
  writeHash();
  refreshing = refreshing.then(drawShade).catch((error) => status(`Could not draw the shading: ${error.message}`));
  if (state.panel) openPanel(state.panel);
}

async function changeSeason(season) {
  play(false);
  state.season = season;
  await loadSeason(season);
  const days = seasonDays();
  if (!days.includes(state.day)) {
    const mid = `${season}-07-15`;
    state.day = days.includes(mid) ? mid : days[Math.floor(days.length / 2)];
  }
  if (state.panel && state.panel.type === 'fire' && !S.fires[season].columns.id.includes(state.panel.id)) {
    state.panel = null;                         // a fire of another season; a place keeps its panel
    $('panel').hidden = true;
  }
  refresh();
}

function wire() {
  $('season').addEventListener('change', (e) => changeSeason(e.target.value));
  $('day').addEventListener('input', (e) => setDay(seasonDays()[Number(e.target.value)]));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('prev-monday').addEventListener('click', () => jumpMonday(-1));
  $('next-monday').addEventListener('click', () => jumpMonday(1));
  $('play').addEventListener('click', () => play(!state.playing));
  $('layer-fires').addEventListener('change', (e) => { state.fires = e.target.checked; refresh(); });
  $('layer-zones').addEventListener('change', (e) => { state.zones = e.target.checked; refresh(); });
  $('fire-window').addEventListener('change', (e) => { state.window = e.target.value; refresh(); });
  $('fire-colour').addEventListener('change', (e) => { state.colour = e.target.value; refresh(); });
  $('model-period').addEventListener('change', (e) => { state.period = e.target.value; if (state.shade === 'model') refresh(); else writeHash(); });
  document.querySelectorAll('input[name="shade"]').forEach((input) => input.addEventListener('change', (e) => {
    state.shade = e.target.value;
    refresh();
  }));
  $('panel-close').addEventListener('click', closePanel);
  $('about-open').addEventListener('click', () => $('about').showModal());
  $('about-close').addEventListener('click', () => $('about').close());
  $('drawer-toggle').addEventListener('click', () => {
    const open = $('controls').classList.toggle('open');
    $('drawer-toggle').setAttribute('aria-expanded', String(open));
    $('drawer-toggle').lastElementChild.textContent = open ? 'Hide' : 'Show';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('panel').hidden) closePanel();
    if (e.target.closest && e.target.closest('input, select, button, dialog')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { drawBase(); refresh(); });
}

async function start() {
  const aboutAtStart = new URLSearchParams(window.location.hash.slice(1)).get('about') === '1';
  try {
    readHash();
    const [manifest, grid, legends, base] = await Promise.all([
      cache.get('manifest.json'), cache.get('grid.json'), cache.get('legends.json'), cache.get('base/canada.json.gz'),
    ]);
    Object.assign(S, { manifest, grid, legends, base });
    if (state.view) map.setView(ll(state.view.x, state.view.y), state.view.z, { animate: false });
    // after the reader moves the map (drag, wheel, pinch, buttons, keys), the address keeps the view too
    let moved = !!state.view;
    for (const kind of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
      map.getContainer().addEventListener(kind, () => { moved = true; }, { passive: true });
    }
    map.on('moveend', () => {
      if (!moved || !document.body.dataset.ready) return;
      const c = map.getCenter();
      state.view = { z: map.getZoom(), x: c.lng, y: c.lat };
      writeHash();
    });
    drawBase();
    const seasons = manifest.seasons;
    $('season').innerHTML = seasons.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (!seasons.includes(state.season)) state.season = seasons[seasons.length - 1];
    $('bundle-note').textContent = `Data bundle ${manifest.bundle_id}, built ${manifest.build_utc.slice(0, 10)}`
      + `${grid.synthetic ? ' · SYNTHETIC test data: every number is made up' : ''}.`;
    if (grid.synthetic) document.title = 'Canada fire map (synthetic test data)';
    wire();
    await changeSeason(state.season);
    if (aboutAtStart) $('about').showModal();     // "#...&about=1" opens the About panel (shared links, the check)
    document.body.dataset.viewport = `${window.innerWidth}x${window.innerHeight}`;   // read by the browser check
    document.body.dataset.ready = 'true';
  } catch (error) {
    status(`The map could not load its data: ${error.message}`);
    document.body.dataset.ready = 'error';
    throw error;
  }
}

start();

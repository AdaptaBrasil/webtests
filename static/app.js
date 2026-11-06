const sepSelect = document.getElementById('sep');
const indicatorSelect = document.getElementById('indicator');
const stateSelect = document.getElementById('state');
const countySelect = document.getElementById('county');
const loadStatus = document.getElementById('loadStatus');
const legendBox = document.getElementById('legend');
const legendTitle = document.getElementById('legendTitle');
const legendItems = document.getElementById('legendItems');
const debugCheckbox = document.getElementById('debug');
const debugPanel = document.getElementById('debugPanel');
const debugSql = document.getElementById('debugSql');

let map = null;
let mapReadyPromise = null;

// --- Debug SQL ---------------------------------------------------------------
// With "Debug" checked, every API request asks the server for the SQL it ran
// (header X-Debug-SQL: 1). The server returns it, parameters merged in, as a
// URL-encoded JSON list in the X-Debug-SQL response header; it's appended to
// the debug memo, ready to paste into a SQL client.

function appendDebugSql(label, statements) {
  const block = [`-- ${label}  [${new Date().toLocaleTimeString()}]`, ...statements].join('\n');
  debugSql.value += (debugSql.value ? '\n\n' : '') + block;
  debugSql.scrollTop = debugSql.scrollHeight;
}

// Fetch JSON; returns { data, sql }. sql is the list of statements the server
// ran (debug on), or null (debug off).
async function apiFetch(url, options = {}) {
  const debug = debugCheckbox.checked;
  const headers = { ...(options.headers || {}) };
  const init = { ...options, headers };
  if (debug) {
    headers['X-Debug-SQL'] = '1';
    // Skip the browser's HTTP cache: a copy cached without debug carries no
    // SQL, and in debug mode the point is to see the real request.
    init.cache = 'no-cache';
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!debug) return { data, sql: null };
  const rawSql = res.headers.get('X-Debug-SQL');
  const sql = rawSql
    ? JSON.parse(decodeURIComponent(rawSql))
    : ['-- (o servidor não retornou SQL para esta requisição)'];
  return { data, sql };
}

// Fetch JSON, logging the request's SQL to the debug memo.
async function fetchJson(url, options = {}) {
  const { data, sql } = await apiFetch(url, options);
  if (sql) appendDebugSql(`${options.method || 'GET'} ${url}`, sql);
  return data;
}

debugCheckbox.addEventListener('change', () => {
  debugPanel.hidden = !debugCheckbox.checked;
  // The panel can change the filter bar's height; let the map refit.
  if (map) map.resize();
});
document.getElementById('debugClear').addEventListener('click', () => {
  debugSql.value = '';
});
document.getElementById('debugCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(debugSql.value);
  } catch {
    // Clipboard API needs HTTPS or localhost; fall back to selecting the text.
    debugSql.select();
    document.execCommand('copy');
  }
});

function fillSelect(select, items, valueKey, labelKey, placeholder) {
  select.innerHTML = '';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);

  for (const item of items) {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = item[labelKey];
    select.appendChild(option);
  }
}

async function loadSeps() {
  const data = await fetchJson('/api/seps');
  fillSelect(sepSelect, data, 'id', 'name', '(selecione)');
}

async function loadIndicators(sepId) {
  indicatorSelect.innerHTML = '<option value="">(selecione)</option>';
  indicatorSelect.disabled = true;
  if (!sepId) return;

  const data = await fetchJson(`/api/indicators?sep_id=${encodeURIComponent(sepId)}`);
  // The user may have picked another sector while this was loading.
  if (sepSelect.value !== sepId) return;
  fillSelect(indicatorSelect, data, 'id', 'name', '(selecione)');
  indicatorSelect.disabled = false;
}

// "Estado" value for the whole country (see loadBrasilMap()).
const BRASIL = 'BR';
const isBrasil = () => stateSelect.value === BRASIL;

async function loadStates() {
  const data = await fetchJson('/api/states');
  fillSelect(stateSelect, data, 'id', 'state', '(selecione)');
  const brasil = document.createElement('option');
  brasil.value = BRASIL;
  brasil.textContent = 'Brasil';
  stateSelect.insertBefore(brasil, stateSelect.options[1]);
}

async function loadCounties(stateId) {
  // Cleared right away, not after the fetch: the map loads as soon as the
  // state changes and must not see the previous state's municipality.
  countySelect.innerHTML = '<option value="">(selecione)</option>';
  countySelect.disabled = true;
  if (!stateId || stateId === BRASIL) return;
  const data = await fetchJson(`/api/counties?state_id=${encodeURIComponent(stateId)}`);
  // The user may have picked another state while this was loading.
  if (stateSelect.value !== stateId) return;
  fillSelect(countySelect, data, 'id', 'name', '(selecione)');
  countySelect.disabled = false;
}

sepSelect.addEventListener('change', () => {
  loadIndicators(sepSelect.value);
  scheduleMapLoad();
});

// --- Map -----------------------------------------------------------------------
// Polygons always come from one vector tile source (/api/tiles/{z}/{x}/{y}.pbf,
// all census tracts of Brazil, built by PostGIS): the browser only loads the
// tiles in view, simplified for the zoom, so a whole state or the whole
// country doesn't mean downloading every polygon. Tiles carry only the
// geoobject id. Which tracts are shown, and their colors, come from
// feature-state set per indicator; tracts without state stay invisible.
//   * state / municipality: /api/values (value + legend color per tract);
//   * Brasil: a precomputed "class string" (legend item per tract, see
//     loadBrasilMap()).

const TRACTS = { source: 'tracts', sourceLayer: 'tracts' };
const COUNTIES = { source: 'counties', sourceLayer: 'counties' };
// Country map: municipalities below this zoom, tracts from it on (set from
// /api/tiles/config).
let countyFillMaxZoom = 5;
const BRAZIL_BOUNDS = [[-74.0, -33.8], [-34.7, 5.3]];

function areaParams() {
  const params = new URLSearchParams({ state_id: stateSelect.value });
  if (countySelect.value) params.set('county_id', countySelect.value);
  return params;
}

// Area bounds by URL, so a prefetch started when an area is picked is reused.
const boundsRequests = new Map();

function getBounds(params) {
  const url = `/api/bounds?${params.toString()}`;
  // Keyed by debug mode too: a copy fetched without debug carries no SQL.
  const key = `${debugCheckbox.checked}|${url}`;
  if (!boundsRequests.has(key)) {
    const request = apiFetch(url).then(({ data, sql }) => ({ data, sql, url }));
    request.catch(() => boundsRequests.delete(key));
    boundsRequests.set(key, request);
  }
  return boundsRequests.get(key);
}

// While the user is still choosing an indicator, have the server read the
// area's values (so the first map for a state isn't slowed by cold disk
// reads) and fetch what the map needs. Fire-and-forget.
function warmArea() {
  if (!stateSelect.value) return;
  if (isBrasil()) {
    getBrasilIds().catch(() => {});
    return;
  }
  const params = areaParams();
  fetchJson(`/api/warm?${params.toString()}`, { method: 'POST' }).catch(() => {});
  getBounds(params).catch(() => {});
}

// The map follows the selects: every change reloads it (see scheduleMapLoad()).
stateSelect.addEventListener('change', () => {
  loadCounties(stateSelect.value);
  warmArea();
  scheduleMapLoad();
});
indicatorSelect.addEventListener('change', scheduleMapLoad);
countySelect.addEventListener('change', () => {
  warmArea();
  scheduleMapLoad();
});

// Legend ranges in Brazilian format, as AdaptaBrasil shows them: "0,00 a 0,19".
const rangeFormat = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const legendRange = (item) => `${rangeFormat.format(item.minvalue)} a ${rangeFormat.format(item.maxvalue)}`;
// Legend items of the indicator on the map (Brasil: class index -> item).
let currentLegend = [];

function renderLegend(title, items) {
  currentLegend = items;
  legendTitle.textContent = title;
  legendItems.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = item.color;
      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = item.label;
      row.append(swatch, label);
      if (item.minvalue != null && item.maxvalue != null) {
        const range = document.createElement('span');
        range.className = 'legend-range';
        range.textContent = legendRange(item);
        row.append(range);
      }
      return row;
    })
  );
  legendBox.hidden = items.length === 0;
}

// Hover popup data, as {name, county_name[, value]} or the pending request:
// tiles carry no names. State/municipality maps already have each tract's
// value (feature-state), so they ask for the name only, keyed by id. The
// country map has only the legend class, so it also asks for the exact value
// of the painted indicator, keyed by "id|indicator".
const geoobjectLabels = new Map();
// Indicator painted on the Brasil map (set by loadBrasilMap()).
let brasilIndicatorId = null;

function labelKey(id, indicatorId) {
  return indicatorId ? `${id}|${indicatorId}` : `${id}`;
}

function getGeoobjectLabel(id, indicatorId) {
  const key = labelKey(id, indicatorId);
  if (!geoobjectLabels.has(key)) {
    const query = indicatorId ? `?indicator_id=${encodeURIComponent(indicatorId)}` : '';
    const request = fetch(`/api/geoobject/${id}${query}`).then((r) => r.json());
    geoobjectLabels.set(key, request);
    request.then((label) => geoobjectLabels.set(key, label), () => geoobjectLabels.delete(key));
  }
  return Promise.resolve(geoobjectLabels.get(key));
}

const formatValue = (value) => (value == null ? 'Dado indisponível' : Number(value).toFixed(4));

// Popup value text: the exact value -- from feature-state (state/municipality)
// or fetched on hover (Brasil) -- else the legend item, while the Brasil
// value is still loading.
function tipText(state, label) {
  if ('value' in state) return formatValue(state.value);
  if (label && 'value' in label) return formatValue(label.value);
  const item = currentLegend[state.c] || {};
  return item.label + (item.minvalue != null ? ` (${legendRange(item)})` : '');
}

function ensureMap() {
  if (mapReadyPromise) return mapReadyPromise;

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          attribution: 'Esri, Maxar, Earthstar Geographics'
        }
      },
      layers: [
        { id: 'satellite', type: 'raster', source: 'satellite' }
      ]
    },
    center: [-51.9253, -14.235],
    zoom: 3,
    scrollZoom: true,
    dragPan: true
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'geo-tip' });
  const hasColor = ['!=', ['feature-state', 'color'], null];
  const isHovered = ['boolean', ['feature-state', 'hover'], false];

  mapReadyPromise = new Promise((resolve, reject) => {
    map.on('load', async () => {
      try {
        const config = await fetchJson('/api/tiles/config');
        // ?v=: the set's version, so a rebuilt set isn't served from the
        // browser's cache (tiles are cached for a day).
        const tileSource = (path, kind) => ({
          type: 'vector',
          tiles: [`${location.origin}${path}/{z}/{x}/{y}.pbf?v=${config.versions[kind]}`],
          minzoom: config.minzoom,
          maxzoom: config.maxzoom,
          bounds: config.bounds.flat()
        });
        map.addSource('tracts', tileSource('/api/tiles', 'tracts'));
        // State and municipality lines, drawn over the tract colors.
        map.addSource('boundaries', tileSource('/api/boundaries', 'boundaries'));
        // Municipality polygons: the country map below countyFillMaxZoom.
        countyFillMaxZoom = config.county_fill_maxzoom;
        fillSwitchZoom();
        map.on('zoom', updateZoomBox);
        updateZoomBox();
        map.addSource('counties', {
          ...tileSource('/api/municipalities', 'counties'),
          // Built up to here regardless of the switch zoom (see the zoom box).
          maxzoom: config.county_tiles_maxzoom
        });
      } catch (err) {
        reject(err);
        return;
      }
      map.addLayer({
        id: 'tracts-fill',
        type: 'fill',
        source: 'tracts',
        'source-layer': 'tracts',
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'color'], '#888888'],
          'fill-opacity': ['case', ['!', hasColor], 0, isHovered, 0.95, 0.78],
          // Antialiasing draws faint seams between adjacent polygons.
          'fill-antialias': false
        }
      });
      // Country map below countyFillMaxZoom: municipalities colored by the
      // mean of their tracts' values (hidden on state maps).
      map.addLayer({
        id: 'counties-fill',
        type: 'fill',
        source: 'counties',
        'source-layer': 'counties',
        maxzoom: countyFillMaxZoom,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'color'], '#888888'],
          'fill-opacity': ['case', ['!', hasColor], 0, isHovered, 0.95, 0.78],
          'fill-antialias': false
        }
      });
      // Census tract outlines from zoom 11, where tracts are real shapes
      // (below ~z10 many are drawn as 2px squares, which outlines would turn
      // into noise). Only tracts with a color get one, so tracts outside the
      // selected state/municipality stay invisible.
      map.addLayer({
        id: 'tract-lines',
        type: 'line',
        source: 'tracts',
        'source-layer': 'tracts',
        minzoom: 11,
        paint: {
          'line-color': '#ffffff',
          // ['zoom'] must be the top-level interpolate input.
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            11, ['case', hasColor, 0.3, 0],
            14, ['case', hasColor, 0.55, 0]],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 14, 0.8, 16, 1.2]
        }
      });
      // Municipality lines from zoom 6 (the tiles only carry them from there),
      // thin and translucent; state lines at every zoom, darker and wider.
      map.addLayer({
        id: 'county-lines',
        type: 'line',
        source: 'boundaries',
        'source-layer': 'counties',
        minzoom: 6,
        paint: {
          'line-color': '#ffffff',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 10, 0.7],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 10, 1, 14, 1.6]
        }
      });
      map.addLayer({
        id: 'state-lines',
        type: 'line',
        source: 'boundaries',
        'source-layer': 'states',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': '#1b2a33',
          'line-opacity': 0.85,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 6, 1.4, 10, 2.4]
        }
      });
      // The tract under the mouse gets a dark outline.
      map.addLayer({
        id: 'tracts-hover',
        type: 'line',
        source: 'tracts',
        'source-layer': 'tracts',
        paint: {
          'line-color': '#0b3d2e',
          'line-width': 2.2,
          'line-opacity': ['case', isHovered, 1, 0]
        }
      });
      map.addLayer({
        id: 'counties-hover',
        type: 'line',
        source: 'counties',
        'source-layer': 'counties',
        maxzoom: countyFillMaxZoom,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#0b3d2e',
          'line-width': 2.2,
          'line-opacity': ['case', isHovered, 1, 0]
        }
      });

      // Hovered feature: { target (TRACTS or COUNTIES), id }.
      let hovered = null;
      const setHover = (target, id) => {
        if (hovered && hovered.target === target && hovered.id === id) return;
        if (hovered) map.setFeatureState({ ...hovered.target, id: hovered.id }, { hover: false });
        hovered = id == null ? null : { target, id };
        if (hovered) map.setFeatureState({ ...target, id }, { hover: true });
      };
      const isHoveredFeature = (target, id) => hovered && hovered.target === target && hovered.id === id;
      const clearHover = () => {
        setHover(null, null);
        map.getCanvas().style.cursor = '';
        popup.remove();
      };
      const tipHtml = (label, color, text) => `
          <div class="tip-title">${label.name ?? '…'}</div>
          <div class="tip-sub">${label.county_name ?? ''}</div>
          <div class="tip-value">
            <span class="tip-dot" style="background:${color || '#dcdcdc'}"></span>
            ${text}
          </div>`;

      map.on('mousemove', 'tracts-fill', (e) => {
        const feature = e.features.find((f) => f.state && f.state.color != null);
        if (!feature) return clearHover();
        setHover(TRACTS, feature.id);
        map.getCanvas().style.cursor = 'pointer';
        const { color } = feature.state;
        // Brasil tracts carry a class (c), not a value: fetch the value too.
        const indicatorId = 'value' in feature.state ? null : brasilIndicatorId;
        const show = (label) => {
          if (isHoveredFeature(TRACTS, feature.id)) {
            popup.setLngLat(e.lngLat)
              .setHTML(tipHtml(label, color, tipText(feature.state, label)))
              .addTo(map);
          }
        };
        const label = geoobjectLabels.get(labelKey(feature.id, indicatorId));
        if (label && !(label instanceof Promise)) {
          show(label);
        } else {
          show({});
          getGeoobjectLabel(feature.id, indicatorId).then(show).catch(() => {});
        }
      });
      map.on('mouseleave', 'tracts-fill', clearHover);

      // Municipalities (country map, low zoom): name + mean of their tracts.
      map.on('mousemove', 'counties-fill', (e) => {
        const feature = e.features.find((f) => f.state && f.state.color != null);
        if (!feature) return clearHover();
        setHover(COUNTIES, feature.id);
        map.getCanvas().style.cursor = 'pointer';
        const { color } = feature.state;
        const show = (label) => {
          if (isHoveredFeature(COUNTIES, feature.id)) {
            const title = { name: label.name, county_name: 'Média dos setores censitários' };
            popup.setLngLat(e.lngLat)
              .setHTML(tipHtml(title, color, tipText(feature.state)))
              .addTo(map);
          }
        };
        const label = geoobjectLabels.get(labelKey(feature.id, null));
        if (label && !(label instanceof Promise)) {
          show(label);
        } else {
          show({});
          getGeoobjectLabel(feature.id, null).then(show).catch(() => {});
        }
      });
      map.on('mouseleave', 'counties-fill', clearHover);

      resolve(map);
    });
  });

  return mapReadyPromise;
}

// Give the tracts in `states` (id -> feature-state) their color; every other
// tract becomes invisible. Feature-state applies to tiles loaded later too.
function paintTracts(readyMap, states, target = TRACTS) {
  readyMap.removeFeatureState(target);
  for (const [id, state] of states) {
    readyMap.setFeatureState({ ...target, id }, state);
  }
}

// Country map: municipality polygons below countyFillMaxZoom, tracts from it
// on. State/municipality maps: tracts at every zoom.
let brasilMode = false;

function applyLayerZooms(readyMap) {
  for (const id of ['counties-fill', 'counties-hover']) {
    readyMap.setLayerZoomRange(id, 0, countyFillMaxZoom);
  }
  for (const id of ['tracts-fill', 'tracts-hover']) {
    readyMap.setLayerZoomRange(id, brasilMode ? countyFillMaxZoom : 0, 24);
  }
}

function setBrasilMode(readyMap, on) {
  brasilMode = on;
  for (const id of ['counties-fill', 'counties-hover']) {
    readyMap.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  applyLayerZooms(readyMap);
  if (!on) readyMap.removeFeatureState(COUNTIES);
  updateZoomBox();
}

// --- Zoom readout + switch level (testing aid) ---------------------------------
// Shows the current zoom and what's drawn; on the Brasil map, a select moves
// the zoom where municipalities give way to tracts (not saved: the server's
// COUNTY_FILL_MAX_ZOOM is the default on every page load).
const zoomLevel = document.getElementById('zoomLevel');
const zoomShowing = document.getElementById('zoomShowing');
const switchField = document.getElementById('switchField');
const switchZoom = document.getElementById('switchZoom');

function updateZoomBox() {
  if (!map) return;
  const zoom = map.getZoom();
  zoomLevel.textContent = zoom.toFixed(1);
  if (currentAreaKey == null) {
    zoomShowing.textContent = '';
  } else {
    zoomShowing.textContent = brasilMode && zoom < countyFillMaxZoom ? '· municípios' : '· setores';
  }
  switchField.hidden = !brasilMode;
}

function fillSwitchZoom() {
  switchZoom.innerHTML = '';
  for (let z = 4; z <= 12; z++) {
    const option = document.createElement('option');
    option.value = z;
    option.textContent = z;
    switchZoom.appendChild(option);
  }
  switchZoom.value = countyFillMaxZoom;
}

switchZoom.addEventListener('change', () => {
  countyFillMaxZoom = Number(switchZoom.value);
  if (map) applyLayerZooms(map);
  updateZoomBox();
});

// Area (state:county or Brasil) the map is zoomed to, so it only refits when
// the area changes.
let currentAreaKey = null;

function startLoading() {
  loadStatus.textContent = 'Carregando mapa...';
  loadStatus.dataset.state = 'loading';
  return performance.now();
}

function finishLoading(startTime, text) {
  const seconds = ((performance.now() - startTime) / 1000).toFixed(1);
  loadStatus.textContent = `${text} em ${seconds} seg`;
  loadStatus.dataset.state = 'ok';
  updateZoomBox();
}

// --- Whole country (Brasil) ------------------------------------------------------
// Values for the whole country are too slow to read per request (~200 s:
// `value` is stored grouped by tract), so the server precomputes, per
// indicator, a "class string": character i is the legend item of the i-th
// tract in the id list from /api/brasil/ids ("-" = no value).

let brasilIdsRequest = null;

function getBrasilIds() {
  if (!brasilIdsRequest) {
    brasilIdsRequest = apiFetch('/api/brasil/ids').then(({ data, sql }) => {
      // Delta-encoded: first id, then differences.
      const ids = new Array(data.deltas.length);
      let id = 0;
      data.deltas.forEach((d, i) => { ids[i] = id += d; });
      return { ids, version: data.version, sql };
    });
    brasilIdsRequest.catch(() => { brasilIdsRequest = null; });
  }
  return brasilIdsRequest;
}

async function loadBrasilMap(load) {
  const indicatorId = indicatorSelect.value;
  const classesUrl = `/api/brasil/classes?indicator_id=${encodeURIComponent(indicatorId)}`;
  const legendUrl = `/api/legend?indicator_id=${encodeURIComponent(indicatorId)}`;
  const countiesUrl = `/api/brasil/counties?indicator_id=${encodeURIComponent(indicatorId)}`;
  const [ids, classes, counties, legend, readyMap] = await Promise.all([
    getBrasilIds(),
    apiFetch(classesUrl, { signal: load.signal }),
    apiFetch(countiesUrl, { signal: load.signal }),
    apiFetch(legendUrl, { signal: load.signal }),
    ensureMap()
  ]);
  if (!load.isCurrent()) return;
  if (classes.data.version !== ids.version) {
    // The server's tract list changed since the ids were loaded.
    brasilIdsRequest = null;
    throw new Error('lista de setores desatualizada; tente novamente');
  }
  if (debugCheckbox.checked) {
    appendDebugSql('GET /api/brasil/ids', ids.sql || ['-- (carregada com o Debug desligado)']);
    appendDebugSql(`GET ${classesUrl}`, classes.sql);
    appendDebugSql(`GET ${countiesUrl}`, counties.sql);
    appendDebugSql(`GET ${legendUrl}`, legend.sql);
  }

  const colors = legend.data.map((item) => item.color);
  const str = classes.data.classes;
  const states = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) - 48; // '0' -> 0; '-' -> negative
    if (c >= 0) states.push([ids.ids[i], { c, color: colors[c] }]);
  }
  paintTracts(readyMap, states);
  // Municipalities: class of the mean of their tracts' values.
  const county = counties.data;
  const countyStates = [];
  for (let i = 0; i < county.ids.length; i++) {
    const k = county.classes.charCodeAt(i) - 48;
    if (k >= 0) countyStates.push([county.ids[i], { c: k, color: colors[k], value: county.values[i] }]);
  }
  paintTracts(readyMap, countyStates, COUNTIES);
  setBrasilMode(readyMap, true);
  brasilIndicatorId = indicatorId;
  renderLegend(indicatorSelect.selectedOptions[0].textContent, legend.data);
  if (currentAreaKey !== 'BR') readyMap.fitBounds(BRAZIL_BOUNDS, { padding: 20, duration: 500 });
  currentAreaKey = 'BR';
  // Both are loaded: municipalities are drawn below countyFillMaxZoom,
  // tracts from it on.
  finishLoading(
    load.startTime,
    `Brasil: ${countyStates.length.toLocaleString('pt-BR')} municípios e ` +
      `${states.length.toLocaleString('pt-BR')} setores`
  );
}

// --- State / municipality ----------------------------------------------------------

async function loadAreaMap(load) {
  const scope = areaParams();
  const valueParams = new URLSearchParams(scope);
  valueParams.set('indicator_id', indicatorSelect.value);
  const valuesUrl = `/api/values?${valueParams.toString()}`;
  const legendUrl = `/api/legend?indicator_id=${encodeURIComponent(indicatorSelect.value)}`;
  const [bounds, values, legend, readyMap] = await Promise.all([
    getBounds(scope), // shared prefetch: not aborted
    apiFetch(valuesUrl, { signal: load.signal }),
    apiFetch(legendUrl, { signal: load.signal }),
    ensureMap()
  ]);
  if (!load.isCurrent()) return;
  if (debugCheckbox.checked) {
    appendDebugSql(`GET ${bounds.url}`, bounds.sql || ['-- (carregados com o Debug desligado)']);
    appendDebugSql(`GET ${valuesUrl}`, values.sql);
    appendDebugSql(`GET ${legendUrl}`, legend.sql);
  }

  const rows = values.data;
  setBrasilMode(readyMap, false);
  paintTracts(readyMap, rows.map((row) => [row.geoobject_id, { color: row.color, value: row.value }]));
  renderLegend(indicatorSelect.selectedOptions[0].textContent, legend.data);
  const areaKey = scope.toString();
  if (areaKey !== currentAreaKey && bounds.data) {
    readyMap.fitBounds(bounds.data, { padding: 40, duration: 500 });
  }
  currentAreaKey = areaKey;
  finishLoading(load.startTime, `${rows.length.toLocaleString('pt-BR')} setores`);
}

// --- Automatic loading ---------------------------------------------------------------
// There's no "show map" button: once sector, indicator and state are chosen,
// any change to the selects reloads the map. Loads can overlap (e.g. the user
// picks MG, then BH, while MG is still loading), so each load gets a sequence
// number: a newer load aborts the older one's requests, and an older load that
// still finishes is discarded instead of painting over the newer map.

const LOAD_DELAY_MS = 300; // arrow keys in a select fire one change per step
let loadTimer = null;
let loadSeq = 0;
let loadController = null;

function showHint(text) {
  loadStatus.textContent = text;
  delete loadStatus.dataset.state;
}

function missingSelection() {
  if (!sepSelect.value) return 'Selecione o setor estratégico';
  if (!indicatorSelect.value) return 'Selecione um indicador';
  if (!stateSelect.value) return 'Selecione um estado';
  return null;
}

function scheduleMapLoad() {
  clearTimeout(loadTimer);
  const missing = missingSelection();
  if (missing) {
    // Cancel any load in flight; the map keeps showing the last indicator.
    loadSeq++;
    if (loadController) loadController.abort();
    showHint(missing);
    return;
  }
  loadTimer = setTimeout(loadMapData, LOAD_DELAY_MS);
}

async function loadMapData() {
  const seq = ++loadSeq;
  if (loadController) loadController.abort();
  loadController = new AbortController();
  const load = {
    signal: loadController.signal,
    isCurrent: () => seq === loadSeq,
    startTime: startLoading()
  };
  try {
    await (isBrasil() ? loadBrasilMap(load) : loadAreaMap(load));
  } catch (err) {
    if (!load.isCurrent()) return; // superseded: its errors (aborts) don't matter
    loadStatus.textContent = 'Erro ao carregar o mapa';
    loadStatus.dataset.state = 'error';
    throw err;
  }
}

loadSeps();
loadStates();
showHint(missingSelection());

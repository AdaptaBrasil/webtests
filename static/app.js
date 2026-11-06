const sepSelect = document.getElementById('sep');
const indicatorSelect = document.getElementById('indicator');
const stateSelect = document.getElementById('state');
const countySelect = document.getElementById('county');
const loadButton = document.getElementById('loadMap');
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

function updateLoadButtonState() {
  loadButton.disabled = !(indicatorSelect.value && stateSelect.value);
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
  if (!stateId || stateId === BRASIL) {
    countySelect.innerHTML = '<option value="">(selecione)</option>';
    countySelect.disabled = true;
    return;
  }
  const data = await fetchJson(`/api/counties?state_id=${encodeURIComponent(stateId)}`);
  fillSelect(countySelect, data, 'id', 'name', '(selecione)');
  countySelect.disabled = false;
}

sepSelect.addEventListener('change', () => {
  loadIndicators(sepSelect.value);
  updateLoadButtonState();
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

stateSelect.addEventListener('change', () => {
  loadCounties(stateSelect.value);
  updateLoadButtonState();
  warmArea();
});
indicatorSelect.addEventListener('change', updateLoadButtonState);
countySelect.addEventListener('change', () => {
  updateLoadButtonState();
  warmArea();
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

// geoobject id -> {name, county_name} (or the pending request), for hover:
// tiles carry no names.
const geoobjectLabels = new Map();

function getGeoobjectLabel(id) {
  if (!geoobjectLabels.has(id)) {
    const request = fetch(`/api/geoobject/${id}`).then((r) => r.json());
    geoobjectLabels.set(id, request);
    request.then((label) => geoobjectLabels.set(id, label), () => geoobjectLabels.delete(id));
  }
  return Promise.resolve(geoobjectLabels.get(id));
}

// Popup value text: the exact value (state/municipality), or the legend
// item (Brasil, where only the class is precomputed).
function tipText(state) {
  if ('value' in state) {
    return state.value == null ? 'Dado indisponível' : Number(state.value).toFixed(4);
  }
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
        const tileSource = (path) => ({
          type: 'vector',
          tiles: [`${location.origin}${path}/{z}/{x}/{y}.pbf`],
          minzoom: config.minzoom,
          maxzoom: config.maxzoom,
          bounds: config.bounds.flat()
        });
        map.addSource('tracts', tileSource('/api/tiles'));
        // State and municipality lines, drawn over the tract colors.
        map.addSource('boundaries', tileSource('/api/boundaries'));
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
      // No lines between tracts: only the one under the mouse gets an outline.
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

      let hoveredId = null;
      const setHover = (id) => {
        if (hoveredId === id) return;
        if (hoveredId != null) map.setFeatureState({ ...TRACTS, id: hoveredId }, { hover: false });
        hoveredId = id;
        if (id != null) map.setFeatureState({ ...TRACTS, id }, { hover: true });
      };
      const clearHover = () => {
        setHover(null);
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
        setHover(feature.id);
        map.getCanvas().style.cursor = 'pointer';
        const { color } = feature.state;
        const text = tipText(feature.state);
        const show = (label) => {
          if (hoveredId === feature.id) {
            popup.setLngLat(e.lngLat).setHTML(tipHtml(label, color, text)).addTo(map);
          }
        };
        const label = geoobjectLabels.get(feature.id);
        if (label && !(label instanceof Promise)) {
          show(label);
        } else {
          show({});
          getGeoobjectLabel(feature.id).then(show).catch(() => {});
        }
      });
      map.on('mouseleave', 'tracts-fill', clearHover);

      resolve(map);
    });
  });

  return mapReadyPromise;
}

// Give the tracts in `states` (id -> feature-state) their color; every other
// tract becomes invisible. Feature-state applies to tiles loaded later too.
function paintTracts(readyMap, states) {
  readyMap.removeFeatureState(TRACTS);
  for (const [id, state] of states) {
    readyMap.setFeatureState({ ...TRACTS, id }, state);
  }
}

// Area (state:county or Brasil) the map is zoomed to, so it only refits when
// the area changes.
let currentAreaKey = null;

function startLoading() {
  loadButton.disabled = true;
  loadStatus.textContent = 'Carregando mapa...';
  loadStatus.dataset.state = 'loading';
  return performance.now();
}

function finishLoading(startTime, text) {
  const seconds = ((performance.now() - startTime) / 1000).toFixed(1);
  loadStatus.textContent = `${text} em ${seconds} seg`;
  loadStatus.dataset.state = 'ok';
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

async function loadBrasilMap(startTime) {
  const indicatorId = indicatorSelect.value;
  const classesUrl = `/api/brasil/classes?indicator_id=${encodeURIComponent(indicatorId)}`;
  const legendUrl = `/api/legend?indicator_id=${encodeURIComponent(indicatorId)}`;
  const [ids, classes, legend, readyMap] = await Promise.all([
    getBrasilIds(),
    apiFetch(classesUrl),
    apiFetch(legendUrl),
    ensureMap()
  ]);
  if (classes.data.version !== ids.version) {
    // The server's tract list changed since the ids were loaded.
    brasilIdsRequest = null;
    throw new Error('lista de setores desatualizada; tente novamente');
  }
  if (debugCheckbox.checked) {
    appendDebugSql('GET /api/brasil/ids', ids.sql || ['-- (carregada com o Debug desligado)']);
    appendDebugSql(`GET ${classesUrl}`, classes.sql);
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
  renderLegend(indicatorSelect.selectedOptions[0].textContent, legend.data);
  if (currentAreaKey !== 'BR') readyMap.fitBounds(BRAZIL_BOUNDS, { padding: 20, duration: 500 });
  currentAreaKey = 'BR';
  finishLoading(startTime, `${states.length.toLocaleString('pt-BR')} setores (Brasil)`);
}

// --- State / municipality ----------------------------------------------------------

async function loadAreaMap(startTime) {
  const scope = areaParams();
  const valueParams = new URLSearchParams(scope);
  valueParams.set('indicator_id', indicatorSelect.value);
  const valuesUrl = `/api/values?${valueParams.toString()}`;
  const legendUrl = `/api/legend?indicator_id=${encodeURIComponent(indicatorSelect.value)}`;
  const [bounds, values, legend, readyMap] = await Promise.all([
    getBounds(scope),
    apiFetch(valuesUrl),
    apiFetch(legendUrl),
    ensureMap()
  ]);
  if (debugCheckbox.checked) {
    appendDebugSql(`GET ${bounds.url}`, bounds.sql || ['-- (carregados com o Debug desligado)']);
    appendDebugSql(`GET ${valuesUrl}`, values.sql);
    appendDebugSql(`GET ${legendUrl}`, legend.sql);
  }

  const rows = values.data;
  paintTracts(readyMap, rows.map((row) => [row.geoobject_id, { color: row.color, value: row.value }]));
  renderLegend(indicatorSelect.selectedOptions[0].textContent, legend.data);
  const areaKey = scope.toString();
  if (areaKey !== currentAreaKey && bounds.data) {
    readyMap.fitBounds(bounds.data, { padding: 40, duration: 500 });
  }
  currentAreaKey = areaKey;
  finishLoading(startTime, `${rows.length.toLocaleString('pt-BR')} setores`);
}

async function loadMapData() {
  const startTime = startLoading();
  try {
    await (isBrasil() ? loadBrasilMap(startTime) : loadAreaMap(startTime));
  } catch (err) {
    loadStatus.textContent = 'Erro ao carregar o mapa';
    loadStatus.dataset.state = 'error';
    throw err;
  } finally {
    loadButton.disabled = false;
  }
}

loadButton.addEventListener('click', loadMapData);

loadSeps();
loadStates();

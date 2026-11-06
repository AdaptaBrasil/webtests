const sepSelect = document.getElementById('sep');
const indicatorSelect = document.getElementById('indicator');
const stateSelect = document.getElementById('state');
const countySelect = document.getElementById('county');
const loadButton = document.getElementById('loadMap');
const loadStatus = document.getElementById('loadStatus');
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

async function loadStates() {
  const data = await fetchJson('/api/states');
  fillSelect(stateSelect, data, 'id', 'state', '(selecione)');
}

async function loadCounties(stateId) {
  if (!stateId) {
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
// Geometry requests by URL, so a prefetch started when an area is picked is
// reused (not repeated) when the map is loaded.
const geometryRequests = new Map();
const MAX_CACHED_GEOMETRIES = 4;

function areaParams() {
  const params = new URLSearchParams({ state_id: stateSelect.value });
  if (countySelect.value) params.set('county_id', countySelect.value);
  return params;
}

function getGeometry(params) {
  const url = `/api/geometry?${params.toString()}`;
  // Keyed by debug mode too: a copy fetched without debug carries no SQL.
  const key = `${debugCheckbox.checked}|${url}`;
  if (!geometryRequests.has(key)) {
    const request = apiFetch(url).then(({ data, sql }) => ({ data, sql, url }));
    // Drop failed requests so the next attempt retries.
    request.catch(() => geometryRequests.delete(key));
    geometryRequests.set(key, request);
    // Keep only the most recent areas; large states are several MB each.
    while (geometryRequests.size > MAX_CACHED_GEOMETRIES) {
      geometryRequests.delete(geometryRequests.keys().next().value);
    }
  }
  return geometryRequests.get(key);
}

// While the user is still choosing an indicator, have the server read the
// area's values (so the first map for a state isn't slowed by cold disk
// reads) and fetch its geometry. Both are fire-and-forget.
function warmArea() {
  if (!stateSelect.value) return;
  const params = areaParams();
  fetchJson(`/api/warm?${params.toString()}`, { method: 'POST' }).catch(() => {});
  getGeometry(params).catch(() => {});
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

function computeBounds(geojson) {
  let bounds = null;
  const extend = (lng, lat) => {
    if (!bounds) {
      bounds = [[lng, lat], [lng, lat]];
    } else {
      bounds[0][0] = Math.min(bounds[0][0], lng);
      bounds[0][1] = Math.min(bounds[0][1], lat);
      bounds[1][0] = Math.max(bounds[1][0], lng);
      bounds[1][1] = Math.max(bounds[1][1], lat);
    }
  };
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      extend(coords[0], coords[1]);
    } else {
      coords.forEach(walk);
    }
  };
  for (const feature of geojson.features) {
    if (feature.geometry) walk(feature.geometry.coordinates);
  }
  return bounds;
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

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

  // Polygons are drawn from the geometry source; their color and visibility
  // come from per-feature state set by applyValues(), so switching indicators
  // only updates feature state instead of reloading geometry. Geoobjects
  // without a value for the current indicator stay invisible.
  const hasValue = ['boolean', ['feature-state', 'hasValue'], false];

  mapReadyPromise = new Promise((resolve) => {
    map.on('load', () => {
      map.addSource('geoobjects', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'geovalue-fill',
        type: 'fill',
        source: 'geoobjects',
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'color'], '#888888'],
          'fill-opacity': ['case', hasValue, 0.75, 0]
        }
      });
      map.addLayer({
        id: 'geovalue-outline',
        type: 'line',
        source: 'geoobjects',
        paint: {
          'line-color': '#222222',
          'line-width': 0.6,
          'line-opacity': ['case', hasValue, 1, 0]
        }
      });

      map.on('mousemove', 'geovalue-fill', (e) => {
        const feature = e.features.find((f) => currentValues.has(f.id));
        if (!feature) {
          map.getCanvas().style.cursor = '';
          popup.remove();
          return;
        }
        map.getCanvas().style.cursor = 'pointer';
        const { county_name, name } = feature.properties;
        const { value } = currentValues.get(feature.id);
        const html = [
          `<strong>Município:</strong> ${county_name}`,
          `<strong>Nome:</strong> ${name}`,
          `<strong>Valor:</strong> ${value == null ? '—' : Number(value).toFixed(4)}`
        ].join('<br>');
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('mouseleave', 'geovalue-fill', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      resolve(map);
    });
  });

  return mapReadyPromise;
}

// Key ("state:county") of the geometry currently in the map's source, so
// geometry is only fetched and redrawn when the state/county changes.
let currentGeometryKey = null;
// Debug: { url, sql } of the request that produced the geometry on the map.
let currentGeometryDebug = null;
let currentBounds = null;
// geoobject_id -> {value, color} row for the indicator currently shown.
let currentValues = new Map();

function applyValues(readyMap, rows) {
  readyMap.removeFeatureState({ source: 'geoobjects' });
  currentValues = new Map();
  for (const row of rows) {
    currentValues.set(row.geoobject_id, row);
    readyMap.setFeatureState(
      { source: 'geoobjects', id: row.geoobject_id },
      { hasValue: true, color: row.color }
    );
  }
}

async function loadMapData() {
  const stateId = stateSelect.value;
  const countyId = countySelect.value;
  const scope = areaParams();
  const valueParams = new URLSearchParams(scope);
  valueParams.set('indicator_id', indicatorSelect.value);

  const geometryKey = `${stateId}:${countyId}`;
  const needGeometry = geometryKey !== currentGeometryKey;

  loadButton.disabled = true;
  loadStatus.textContent = 'Carregando mapa...';
  const startTime = performance.now();
  try {
    const valuesUrl = `/api/values?${valueParams.toString()}`;
    const [geometry, values, readyMap] = await Promise.all([
      needGeometry ? getGeometry(scope) : null,
      apiFetch(valuesUrl),
      ensureMap()
    ]);
    const rows = values.data;

    if (needGeometry) currentGeometryDebug = { url: geometry.url, sql: geometry.sql };
    if (debugCheckbox.checked) {
      // Polygons first, then values -- the order the map uses them.
      const g = currentGeometryDebug;
      const note = needGeometry
        ? '-- polígonos (baixados ao escolher a área ou agora)'
        : '-- polígonos já exibidos no mapa; nenhuma requisição nova. Consulta que os gerou:';
      appendDebugSql(`GET ${g ? g.url : '/api/geometry'}`, [
        note,
        ...((g && g.sql) || ['-- (carregados com o Debug desligado; recarregue a área para ver o SQL)'])
      ]);
      appendDebugSql(`GET ${valuesUrl}`, values.sql);
    }

    if (needGeometry) {
      const geojson = geometry.data;
      readyMap.getSource('geoobjects').setData(geojson);
      currentGeometryKey = geometryKey;
      currentBounds = computeBounds(geojson);
    }
    applyValues(readyMap, rows);

    if (needGeometry && currentBounds) {
      readyMap.fitBounds(currentBounds, { padding: 40, duration: 500 });
    }

    const seconds = ((performance.now() - startTime) / 1000).toFixed(1);
    loadStatus.textContent = `${rows.length} polígonos carregados em ${seconds} seg`;
  } catch (err) {
    loadStatus.textContent = 'Erro ao carregar o mapa';
    throw err;
  } finally {
    loadButton.disabled = false;
  }
}

loadButton.addEventListener('click', loadMapData);

loadSeps();
loadStates();

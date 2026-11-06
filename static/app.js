const sepSelect = document.getElementById('sep');
const indicatorSelect = document.getElementById('indicator');
const stateSelect = document.getElementById('state');
const countySelect = document.getElementById('county');
const loadButton = document.getElementById('loadMap');
const loadStatus = document.getElementById('loadStatus');

let map = null;
let mapReadyPromise = null;

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
  const res = await fetch('/api/seps');
  const data = await res.json();
  fillSelect(sepSelect, data, 'id', 'name', '(selecione)');
}

async function loadIndicators(sepId) {
  indicatorSelect.innerHTML = '<option value="">(selecione)</option>';
  indicatorSelect.disabled = true;
  if (!sepId) return;

  const res = await fetch(`/api/indicators?sep_id=${encodeURIComponent(sepId)}`);
  const data = await res.json();
  fillSelect(indicatorSelect, data, 'id', 'name', '(selecione)');
  indicatorSelect.disabled = false;
}

async function loadStates() {
  const res = await fetch('/api/states');
  const data = await res.json();
  fillSelect(stateSelect, data, 'id', 'state', '(selecione)');
}

async function loadCounties(stateId) {
  if (!stateId) {
    countySelect.innerHTML = '<option value="">(selecione)</option>';
    countySelect.disabled = true;
    return;
  }
  const res = await fetch(`/api/counties?state_id=${encodeURIComponent(stateId)}`);
  const data = await res.json();
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
  if (!geometryRequests.has(url)) {
    const request = fetchJson(url);
    // Drop failed requests so the next attempt retries.
    request.catch(() => geometryRequests.delete(url));
    geometryRequests.set(url, request);
    // Keep only the most recent areas; large states are several MB each.
    while (geometryRequests.size > MAX_CACHED_GEOMETRIES) {
      geometryRequests.delete(geometryRequests.keys().next().value);
    }
  }
  return geometryRequests.get(url);
}

// While the user is still choosing an indicator, have the server read the
// area's values (so the first map for a state isn't slowed by cold disk
// reads) and fetch its geometry. Both are fire-and-forget.
function warmArea() {
  if (!stateSelect.value) return;
  const params = areaParams();
  fetch(`/api/warm?${params.toString()}`, { method: 'POST' }).catch(() => {});
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
let currentBounds = null;
// geoobject_id -> {value, color} row for the indicator currently shown.
let currentValues = new Map();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

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
    const [geojson, rows, readyMap] = await Promise.all([
      needGeometry ? getGeometry(scope) : null,
      fetchJson(`/api/values?${valueParams.toString()}`),
      ensureMap()
    ]);

    if (needGeometry) {
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

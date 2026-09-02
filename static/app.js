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
stateSelect.addEventListener('change', () => {
  loadCounties(stateSelect.value);
  updateLoadButtonState();
});
indicatorSelect.addEventListener('change', updateLoadButtonState);
countySelect.addEventListener('change', updateLoadButtonState);

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

  mapReadyPromise = new Promise((resolve) => {
    map.on('load', () => {
      map.addSource('geovalue', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'geovalue-fill',
        type: 'fill',
        source: 'geovalue',
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#888888'],
          'fill-opacity': 0.75
        }
      });
      map.addLayer({
        id: 'geovalue-outline',
        type: 'line',
        source: 'geovalue',
        paint: { 'line-color': '#222222', 'line-width': 0.6 }
      });

      map.on('mousemove', 'geovalue-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const { county_name, name, value } = e.features[0].properties;
        const html = [
          `<strong>Município:</strong> ${county_name}`,
          `<strong>Nome:</strong> ${name}`,
          `<strong>Valor:</strong> ${Number(value).toFixed(4)}`
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

async function loadMapData() {
  const params = new URLSearchParams({
    indicator_id: indicatorSelect.value,
    state_id: stateSelect.value
  });
  if (countySelect.value) params.set('county_id', countySelect.value);

  loadButton.disabled = true;
  loadStatus.textContent = 'Carregando mapa...';
  const startTime = performance.now();
  try {
    const res = await fetch(`/api/geovalues?${params.toString()}`);
    const geojson = await res.json();

    const readyMap = await ensureMap();
    readyMap.getSource('geovalue').setData(geojson);

    const bounds = computeBounds(geojson);
    if (bounds) readyMap.fitBounds(bounds, { padding: 40, duration: 500 });

    const seconds = Math.round((performance.now() - startTime) / 1000);
    loadStatus.textContent = `${geojson.features.length} polígonos carregados em ${seconds} seg`;
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

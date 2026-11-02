/* ==========================================================================
   app.js — Plateforme météo (version statique, compatible GitHub Pages)
   --------------------------------------------------------------------------
   Ce script interroge DIRECTEMENT l'API ThingSpeak depuis le navigateur.
   Aucun serveur backend n'est requis.

   ⚠️  Conséquence : les clés de lecture sont visibles dans ce fichier.
       Utilise uniquement des canaux PUBLICS et des clés "Read Only".
   ========================================================================== */

/* ==========================================================================
   1. CONFIGURATION GÉNÉRALE
   ========================================================================== */

const CONFIG = {
  refreshMs: 60_000,                 // rafraîchissement automatique (ms)
  historyPoints: 96,                 // points affichés sur le graphique
  cacheTtlMs: 55_000,                // durée de vie du cache navigateur
  fetchTimeoutMs: 8_000,             // délai max d'un appel réseau
  thingspeakBase: 'https://api.thingspeak.com',
  mapCenter: [46.6, 2.4],            // centre initial de la carte
  mapZoom: 6,
};

/* ==========================================================================
   2. LISTE DES STATIONS
   --------------------------------------------------------------------------
   Ajoute un objet par station. Les clés "fieldN" doivent correspondre
   aux champs réellement alimentés par ton STM32 dans ThingSpeak.
   ========================================================================== */

const STATIONS = [
  {
    id: 'test_station',
    name: 'Gif-sur-Yvette',
    channelId: '3541968',
    apiKey: '9PBBMO5DAKIAFNJ6',
    lat: 48.701844,
    lon: 2.134078,
    staleAfterMinutes: 30,
    fields: {
      field1: { label: 'Température', unit: '°C' },
      field2: { label: 'Pression', unit: 'hPa' },
      field3: { label: 'Humidité', unit: '%' },
      field4: { label: 'Luminosité', unit: 'lux' },
    },
  },
  {
    id: 'lausanne-01',
    name: 'Lausanne Gare',
    channelId: '789012',
    apiKey: 'AUTRE_CLE_READ_ONLY_ICI',
    lat: 46.5197,
    lon: 6.6275,
    staleAfterMinutes: 30,
    fields: {
      field1: { label: 'Température', unit: '°C' },
      field2: { label: 'Humidité', unit: '%' },
    },
  },
];

/* ==========================================================================
   3. ÉTAT ET CACHE
   ========================================================================== */

const state = {
  selected: null,        // id de la station sélectionnée
  readings: new Map(),   // id -> { timestamp, values }
  markers: new Map(),    // id -> marqueur Leaflet
  chart: null,           // instance Chart.js courante
};

const cache = new Map(); // clé -> { value, expires }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CONFIG.cacheTtlMs) {
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

/* ==========================================================================
   4. ACCÈS À L'API THINGSPEAK
   ========================================================================== */

/**
 * Récupère les mesures d'un canal.
 * @param {object} station  Objet station (channelId, apiKey)
 * @param {number} results  Nombre de mesures souhaitées
 */
async function fetchFeeds(station, results = 1) {
  const url = new URL(`${CONFIG.thingspeakBase}/channels/${station.channelId}/feeds.json`);
  if (station.apiKey) url.searchParams.set('api_key', station.apiKey);
  url.searchParams.set('results', String(results));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ThingSpeak HTTP ${res.status} — ${body.slice(0, 140)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Transforme une entrée brute ThingSpeak en objet lisible. */
function normalizeFeed(feed, station) {
  const values = {};
  for (const [field, meta] of Object.entries(station.fields || {})) {
    const raw = feed[field];
    values[meta.label] =
      raw === null || raw === undefined || raw === '' ? null : Number(raw);
  }
  return { timestamp: feed.created_at, values };
}

/** Une station est "en ligne" si sa dernière mesure est assez récente. */
function isOnline(station, timestamp) {
  if (!timestamp) return false;
  const maxAge = (station.staleAfterMinutes ?? 30) * 60 * 1000;
  return Date.now() - new Date(timestamp).getTime() < maxAge;
}

/* ==========================================================================
   5. UTILITAIRES D'AFFICHAGE
   ========================================================================== */

const els = {
  list: document.getElementById('station-list'),
  status: document.getElementById('status'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detail-title'),
  detailMeta: document.getElementById('detail-meta'),
  detailValues: document.getElementById('detail-values'),
  canvas: document.getElementById('chart'),
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const n = value.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  return unit ? `${n} ${unit}` : n;
}

function fmtDateTime(iso) {
  if (!iso) return 'jamais';
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/* ==========================================================================
   6. INITIALISATION DE LA CARTE
   ========================================================================== */

const map = L.map('map').setView(CONFIG.mapCenter, CONFIG.mapZoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

/* ==========================================================================
   7. RENDU DE LA LISTE LATÉRALE
   ========================================================================== */

function renderList() {
  els.list.innerHTML = '';

  for (const station of STATIONS) {
    const reading = state.readings.get(station.id);
    const online = isOnline(station, reading?.timestamp);

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-btn' + (state.selected === station.id ? ' active' : '');
    btn.innerHTML = `
      <span class="dot ${online ? 'on' : 'off'}"></span>
      <span class="name">${escapeHtml(station.name)}</span>
      <span class="time">${online ? 'à jour' : 'hors ligne'} · ${fmtDateTime(reading?.timestamp)}</span>`;

    btn.addEventListener('click', () => selectStation(station.id));
    li.appendChild(btn);
    els.list.appendChild(li);
  }
}

/* ==========================================================================
   8. MARQUEURS SUR LA CARTE
   ========================================================================== */

function upsertMarkers() {
  for (const station of STATIONS) {
    const reading = state.readings.get(station.id);
    const online = isOnline(station, reading?.timestamp);
    const color = online ? '#34c759' : '#8a8f9c';

    const popup = `
      <strong>${escapeHtml(station.name)}</strong><br>
      ${fmtDateTime(reading?.timestamp)}`;

    let marker = state.markers.get(station.id);

    if (!marker) {
      marker = L.circleMarker([station.lat, station.lon], {
        radius: 9,
        weight: 2,
        color: '#ffffff',
        fillColor: color,
        fillOpacity: 1,
      }).addTo(map);
      marker.on('click', () => selectStation(station.id));
      state.markers.set(station.id, marker);
    } else {
      marker.setLatLng([station.lat, station.lon]);
      marker.setStyle({ fillColor: color });
    }

    marker.bindPopup(popup);
  }
}

/* ==========================================================================
   9. PANNEAU DE DÉTAIL
   ========================================================================== */

function renderDetail(station, reading) {
  els.detail.hidden = false;
  els.detailTitle.textContent = station.name;

  const online = isOnline(station, reading?.timestamp);
  els.detailMeta.textContent =
    `${online ? 'En ligne' : 'Hors ligne'} · dernière mesure ${fmtDateTime(reading?.timestamp)}`;

  els.detailValues.innerHTML = Object.values(station.fields)
    .map((f) => `
      <div class="value">
        <span class="label">${escapeHtml(f.label)}</span>
        <span class="num">${fmtValue(reading?.values?.[f.label], f.unit)}</span>
      </div>`)
    .join('');
}

/* ==========================================================================
   10. GRAPHIQUE HISTORIQUE
   ========================================================================== */

function drawChart(station, series) {
  const labels = series.map((p) =>
    new Date(p.timestamp).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  );

  // Une échelle par unité distincte (3 maximum pour rester lisible)
  const units = [...new Set(Object.values(station.fields).map((f) => f.unit || ''))]
    .slice(0, 3);

  const axisFor = (unit) => {
    const i = units.indexOf(unit || '');
    return i <= 0 ? 'y' : `y${i + 1}`;
  };

  const scales = { x: { ticks: { maxTicksLimit: 8, autoSkip: true } } };

  units.forEach((unit, i) => {
    const axisId = i === 0 ? 'y' : `y${i + 1}`;
    scales[axisId] = {
      position: i === 0 ? 'left' : 'right',
      title: { display: Boolean(unit), text: unit },
      grid: { drawOnChartArea: i === 0 },
    };
  });

  const datasets = Object.values(station.fields).map((f) => ({
    label: f.unit ? `${f.label} (${f.unit})` : f.label,
    data: series.map((p) => p.values[f.label]),
    yAxisID: axisFor(f.unit),
    borderWidth: 2,
    tension: 0.3,
    spanGaps: true,
    pointRadius: 0,
    pointHitRadius: 12,
  }));

  if (state.chart) state.chart.destroy();

  state.chart = new Chart(els.canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales,
    },
  });
}

/* ==========================================================================
   11. SÉLECTION D'UNE STATION
   ========================================================================== */

async function selectStation(id) {
  const station = STATIONS.find((s) => s.id === id);
  if (!station) return;

  state.selected = id;
  renderList();

  const cached = state.readings.get(id);
  renderDetail(station, cached);

  try {
    const cacheKey = `history:${id}`;
    let payload = cacheGet(cacheKey);

    if (!payload) {
      const data = await fetchFeeds(station, CONFIG.historyPoints);
      payload = cacheSet(
        cacheKey,
        (data.feeds || []).map((f) => normalizeFeed(f, station))
      );
    }

    if (!payload.length) {
      els.status.textContent = `Aucune donnée historique pour ${station.name}.`;
      return;
    }

    renderDetail(station, payload.at(-1));
    drawChart(station, payload);
  } catch (err) {
    console.error('[history]', err);
    els.status.textContent = `Historique indisponible pour ${station.name}.`;
  }
}

/* ==========================================================================
   12. RAFRAÎCHISSEMENT GLOBAL
   ========================================================================== */

async function refreshAll() {
  const outcomes = await Promise.allSettled(
    STATIONS.map(async (station) => {
      const cached = cacheGet(`latest:${station.id}`);
      if (cached) return { id: station.id, reading: cached };

      const data = await fetchFeeds(station, 1);
      const feed = (data.feeds || []).at(-1);
      const reading = feed
        ? normalizeFeed(feed, station)
        : { timestamp: null, values: {} };

      cacheSet(`latest:${station.id}`, reading);
      return { id: station.id, reading };
    })
  );

  let failures = 0;

  outcomes.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      state.readings.set(result.value.id, result.value.reading);
    } else {
      failures += 1;
      console.error(`[latest] ${STATIONS[i].name}:`, result.reason);
    }
  });

  renderList();
  upsertMarkers();

  if (failures === 0) {
    els.status.textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
  } else if (failures < STATIONS.length) {
    els.status.textContent = `${failures}/${STATIONS.length} station(s) injoignable(s)`;
  } else {
    els.status.textContent = 'ThingSpeak injoignable — nouvelle tentative dans 1 min';
  }

  // Rafraîchit l'en-tête du panneau si une station est ouverte
  if (state.selected) {
    const station = STATIONS.find((s) => s.id === state.selected);
    if (station) renderDetail(station, state.readings.get(station.id));
  }
}

/* ==========================================================================
   13. DÉMARRAGE
   ========================================================================== */

refreshAll();
setInterval(refreshAll, CONFIG.refreshMs);

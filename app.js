/* ==========================================================================
   app.js — OpenWeatherNetwork
   --------------------------------------------------------------------------
   NOUVEAU : axe des abscisses en ÉCHELLE DE TEMPS RÉELLE (type: 'time').
   
   Conséquences :
   - Les dates/heures affichées sur l'axe X sont celles des mesures réelles
   - La largeur d'une interruption est proportionnelle à sa durée réelle
   - Les coupures sont matérialisées par une rupture de courbe
   
   Autres points :
   - Points de mesure visibles sur les courbes
   - Unité absente de l'axe Y (présente dans le titre de la carte)
   - Station Gif-sur-Yvette (field4 : Luminosité)
   ========================================================================== */

/* ==========================================================================
   1. CONFIGURATION GÉNÉRALE
   ========================================================================== */

const CONFIG = {
  refreshMs: 60_000,
  cacheTtlMs: 55_000,
  fetchTimeoutMs: 15_000,
  thingspeakBase: 'https://api.thingspeak.com',
  mapCenter: [46.85, 2.35],   /* Recentré sur l'Île-de-France */
  mapZoom: 7,
  axisWidth: 58,

  /* Cadence nominale, utilisée uniquement pour estimer le nombre de points
     à demander à ThingSpeak. La détection des interruptions ne dépend plus
     de cette valeur (voir detectGaps). */
  feedIntervalMinutes: 15,
  hoursPerDay: 24,
  daysRanges: { '7d': 7, '14d': 14, '30d': 30 },

  /* Une interruption est signalée si l'écart entre deux mesures dépasse
     ce multiple de l'intervalle médian observé. 2.5 laisse passer un
     créneau isolé manqué, mais signale deux créneaux consécutifs absents. */
  gapFactor: 2.5,

  /* Au-delà de ce nombre de points, les marqueurs sont réduits */
  denseThreshold: 1500,
};

const PALETTE = ['#6d4aff', '#e67e22', '#27ae60', '#e74c3c'];

const HISTORY_RANGES = [
  { key: '7d',  label: '7 jours' },
  { key: '14d', label: '14 jours' },
  { key: '30d', label: '30 jours' },
];

/* ==========================================================================
   2. LISTE DES STATIONS
   ========================================================================== */

const STATIONS = [
  {
    id: 'gif-yvette',
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
  /* AJOUTEZ VOTRE STATION SIMULÉE ICI */
  {
    id: 'simu-station',
    name: 'Station Simulée',
    channelId: '3564665', // Remplacez par votre ID numérique
    apiKey: 'TS58TDURZL07BA51', // Optionnel : mettez la clé de lecture si vous voulez restreindre l'accès
                                    // Sinon laissez vide ou mettez la clé publique si le canal est public.
                                    // Note: Pour lire, il faut souvent la clé si le canal n'est pas public.
    lat: 48.8566,  // Exemple : Paris (vous pouvez changer les coordonnées)
    lon: 2.3522,
    staleAfterMinutes: 30, // Si aucune donnée reçue depuis 30 min, la station passe hors ligne
    fields: {
      field1: { label: 'Température', unit: '°C' },
      field2: { label: 'Humidité', unit: '%' },
      field3: { label: 'Pression', unit: 'hPa' },
      field4: { label: 'Luminosité', unit: 'lux' },
    },
  },
];

/* ==========================================================================
   3. ÉTAT ET CACHE
   ========================================================================== */

const state = {
  selected: null,
  readings: new Map(),
  markers: new Map(),
  chartsDefault: [],
  chartsFull: [],
  historyRange: '7d',
  overlayVisible: false,
};

const cache = new Map();

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
   4. CALCUL DE PLAGE TEMPORELLE
   ========================================================================== */

function calculateTimeRange(hours) {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return {
    start: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function calculateTimeRangeDays(days) {
  return calculateTimeRange(days * 24);
}

function estimateMaxPoints(hours, intervalMinutes = CONFIG.feedIntervalMinutes) {
  return Math.ceil((hours * 60) / intervalMinutes);
}

/* ==========================================================================
   5. ACCÈS À L'API THINGSPEAK
   ========================================================================== */

async function fetchFeedsWithTimeRange(station, { start, end }, maxResults = 1000) {
  const url = new URL(`${CONFIG.thingspeakBase}/channels/${station.channelId}/feeds.json`);

  if (station.apiKey) url.searchParams.set('api_key', station.apiKey);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('results', String(maxResults));

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

async function fetchLatestFeed(station) {
  const url = new URL(`${CONFIG.thingspeakBase}/channels/${station.channelId}/feeds.json`);
  if (station.apiKey) url.searchParams.set('api_key', station.apiKey);
  url.searchParams.set('results', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`ThingSpeak HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
   6. NORMALISATION DES DONNÉES
   ========================================================================== */

function normalizeFeed(feed, station) {
  const values = {};
  for (const [field, meta] of Object.entries(station.fields || {})) {
    const raw = feed[field];
    values[meta.label] =
      raw === null || raw === undefined || raw === '' ? null : Number(raw);
  }
  return { timestamp: feed.created_at, values };
}

function isOnline(station, timestamp) {
  if (!timestamp) return false;
  const maxAge = (station.staleAfterMinutes ?? 30) * 60 * 1000;
  return Date.now() - new Date(timestamp).getTime() < maxAge;
}

/* ==========================================================================
   7. UTILITAIRES D'AFFICHAGE
   ========================================================================== */

const els = {
  list: document.getElementById('station-list'),
  status: document.getElementById('status'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detail-title'),
  detailMeta: document.getElementById('detail-meta'),
  detailValues: document.getElementById('detail-values'),
  btnHistory: document.getElementById('btn-history'),
  charts: document.getElementById('charts'),
  overlay: document.getElementById('history-overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayMeta: document.getElementById('overlay-meta'),
  overlayStatus: document.getElementById('overlay-status'),
  overlayClose: document.getElementById('overlay-close'),
  overlayRanges: document.getElementById('overlay-ranges'),
  overlayCharts: document.getElementById('overlay-charts'),
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

/** Horodatage long, pour les infobulles (accepte un timestamp en ms). */
function fmtLong(ms) {
  return new Date(ms).toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Formatage adaptatif des graduations de l'axe X.
 * Le niveau de détail dépend de l'étendue totale affichée.
 */
function fmtTick(ms, spanMs) {
  const d = new Date(ms);
  const DAY = 24 * 3600 * 1000;

  if (spanMs > 10 * DAY) {
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }
  if (spanMs > 2 * DAY) {
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }
  if (spanMs > DAY) {
    return d.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit',
    });
  }
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/* ==========================================================================
   8. CARTE LEAFLET
   ========================================================================== */

const map = L.map('map').setView(CONFIG.mapCenter, CONFIG.mapZoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

/* ==========================================================================
   9. RENDU DE LA LISTE
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
   10. MARQUEURS CARTE
   ========================================================================== */

function upsertMarkers() {
  for (const station of STATIONS) {
    const reading = state.readings.get(station.id);
    const online = isOnline(station, reading?.timestamp);
    const color = online ? '#27ae60' : '#95a5a6';

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
   11. PANNEAU DÉTAIL
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
   12. PRÉPARATION DES POINTS POUR L'ÉCHELLE DE TEMPS
   ========================================================================== */

/**
 * Convertit une série normalisée en points {x, y} exploitables par une
 * échelle de temps, et insère un point nul au milieu de chaque
 * interruption détectée afin que la courbe se rompe.
 *
 * La détection s'appuie sur l'intervalle MÉDIAN observé, et non sur une
 * cadence supposée : le code s'adapte donc automatiquement à la fréquence
 * réelle d'émission de la station.
 *
 * @param {Array}  series      Mesures normalisées
 * @param {string} fieldLabel  Champ à extraire
 * @returns {Array<{x:number, y:number|null}>}
 */
function buildTimeSeries(series, fieldLabel) {
  // 1. Extraction et tri chronologique
  const points = series
    .map((p) => ({ x: new Date(p.timestamp).getTime(), y: p.values[fieldLabel] }))
    .filter((p) => Number.isFinite(p.x))
    .sort((a, b) => a.x - b.x);

  if (points.length < 3) return points;

  // 2. Intervalle médian entre mesures consécutives
  const deltas = [];
  for (let i = 1; i < points.length; i += 1) {
    deltas.push(points[i].x - points[i - 1].x);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const threshold = median * CONFIG.gapFactor;

  // 3. Insertion d'un point nul au milieu de chaque interruption
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      const prev = points[i - 1];
      const curr = points[i];
      if (curr.x - prev.x > threshold) {
        out.push({ x: prev.x + (curr.x - prev.x) / 2, y: null });
      }
    }
    out.push(points[i]);
  }

  return out;
}

/* ==========================================================================
   13. GRAPHIQUES
   ========================================================================== */

function destroyCharts(charts) {
  charts.forEach((chart) => chart.destroy());
  charts.length = 0;
}

function drawCharts(container, charts, series, station, extraClass = '', rangeBounds = null) {
  destroyCharts(charts);
  container.innerHTML = '';

  if (!series.length) return;

  /* Bornes de l'axe : celles demandées, sinon celles des données.
     Les fixer garantit que l'axe couvre toute la plage même si la station
     s'est tue bien avant la fin de la période. */
  const minX = rangeBounds?.start ? new Date(rangeBounds.start).getTime() : undefined;
  const maxX = rangeBounds?.end ? new Date(rangeBounds.end).getTime() : undefined;
  const spanMs = (minX !== undefined && maxX !== undefined)
    ? maxX - minX
    : (new Date(series.at(-1).timestamp) - new Date(series[0].timestamp));

  const fields = Object.values(station.fields);

  fields.forEach((field, index) => {
    const color = PALETTE[index % PALETTE.length];
    const isLast = index === fields.length - 1;

    /* --- Points {x, y} avec ruptures aux interruptions --- */
    const data = buildTimeSeries(series, field.label);
    const pointRadius = data.length > CONFIG.denseThreshold ? 2 : 3;

    /* --- Carte DOM --- */
    const card = document.createElement('div');
    card.className = `chart-card${extraClass}`;

    const title = document.createElement('h3');
    title.textContent = field.unit ? `${field.label} (${field.unit})` : field.label;
    card.appendChild(title);

    const wrap = document.createElement('div');
    wrap.className = 'chart-canvas';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    card.appendChild(wrap);

    container.appendChild(card);

    /* --- Graphique --- */
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: field.label,
          data,
          borderColor: color,
          backgroundColor: `${color}15`,
          borderWidth: 2.5,
          tension: 0.25,

          /* Rupture de la courbe aux points nuls */
          spanGaps: false,

          /* Points de mesure visibles */
          pointRadius,
          pointHoverRadius: 5,
          pointBackgroundColor: '#fff',
          pointBorderColor: color,
          pointBorderWidth: 2,
          pointHitRadius: 14,
          pointStyle: 'circle',

          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(44, 62, 80, 0.92)',
            titleColor: '#fff',
            bodyColor: '#fff',
            borderColor: '#dfe4ea',
            borderWidth: 1,
            /* On masque les points nuls servant uniquement à rompre la courbe */
            filter: (item) => item.parsed.y !== null && item.parsed.y !== undefined,
            callbacks: {
              title: (items) => (items.length ? fmtLong(items[0].parsed.x) : ''),
              label: (item) => fmtValue(item.parsed.y, field.unit),
            },
          },
        },
        scales: {
          x: {
            /* ÉCHELLE DE TEMPS RÉELLE */
            type: 'time',
            min: minX,
            max: maxX,
            offset: false,
            time: {
              /* Le formatage des graduations est géré par ticks.callback,
                 pour garantir l'affichage en français quelle que soit
                 la locale chargée par l'adaptateur. */
              displayFormats: {
                millisecond: 'HH:mm:ss',
                second: 'HH:mm:ss',
                minute: 'HH:mm',
                hour: 'dd/MM HH:mm',
                day: 'dd/MM',
                week: 'dd/MM',
                month: 'MM/yyyy',
                year: 'yyyy',
              },
            },
            ticks: {
              display: isLast,
              maxTicksLimit: 7,
              autoSkip: true,
              color: '#7f8c8d',
              maxRotation: 45,
              minRotation: 0,
              callback: function (value) {
                return fmtTick(value, spanMs);
              },
            },
            grid: {
              color: '#f0f3f8',
              drawTicks: isLast,
            },
          },
          y: {
            beginAtZero: Boolean(field.beginAtZero),
            /* Pas d'unité sur l'axe : elle figure dans le titre de la carte */
            title: { display: false },
            ticks: {
              color: '#7f8c8d',
              callback: function (value) {
                if (Math.abs(value) >= 1000) {
                  return (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + 'k';
                }
                return Number.isInteger(value) ? value : value.toFixed(1);
              },
            },
            grid: { color: '#e8ecf3' },
            afterFit: (scale) => { scale.width = CONFIG.axisWidth; },
          },
        },
      },
    });

    charts.push(chart);
  });
}

/* ==========================================================================
   14. VUE PLEIN ÉCRAN
   ========================================================================== */

function renderRangeButtons() {
  els.overlayRanges.innerHTML = '';

  HISTORY_RANGES.forEach((range) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'range-btn' + (state.historyRange === range.key ? ' active' : '');
    btn.textContent = range.label;

    btn.addEventListener('click', () => {
      if (state.historyRange === range.key) return;
      state.historyRange = range.key;
      renderRangeButtons();
      loadFullHistory();
    });

    els.overlayRanges.appendChild(btn);
  });
}

function openOverlay() {
  if (!state.selected) return;

  state.overlayVisible = true;
  els.overlay.hidden = false;
  document.body.classList.add('overlay-open');

  loadFullHistory();
}

function closeOverlay() {
  state.overlayVisible = false;
  els.overlay.hidden = true;
  document.body.classList.remove('overlay-open');

  destroyCharts(state.chartsFull);
  els.overlayCharts.innerHTML = '';
  els.overlayStatus.textContent = '';
}

async function loadFullHistory() {
  const station = STATIONS.find((s) => s.id === state.selected);
  if (!station) return;

  const range = HISTORY_RANGES.find((r) => r.key === state.historyRange) || HISTORY_RANGES[0];
  const days = CONFIG.daysRanges[range.key] || 7;
  const timeRange = calculateTimeRangeDays(days);
  const maxPoints = estimateMaxPoints(days * 24);

  els.overlayTitle.textContent = station.name;
  els.overlayMeta.textContent = `Historique sur ${range.label}`;
  els.overlayStatus.textContent = 'Chargement…';

  try {
    const cacheKey = `fullhistory:${station.id}:${range.key}`;
    let payload = cacheGet(cacheKey);

    if (!payload) {
      const data = await fetchFeedsWithTimeRange(station, timeRange, maxPoints);
      payload = cacheSet(
        cacheKey,
        (data.feeds || []).map((f) => normalizeFeed(f, station))
      );
    }

    if (!payload.length) {
      els.overlayStatus.textContent = 'Aucune donnée sur cette période.';
      destroyCharts(state.chartsFull);
      els.overlayCharts.innerHTML = '';
      return;
    }

    const from = fmtDateTime(payload[0].timestamp);
    const to = fmtDateTime(payload.at(-1).timestamp);
    els.overlayStatus.textContent = `${payload.length} mesures — du ${from} au ${to}`;

    drawCharts(els.overlayCharts, state.chartsFull, payload, station,
               ' chart-card-lg', timeRange);
  } catch (err) {
    console.error('[full-history]', err);
    els.overlayStatus.textContent = "Impossible de charger l'historique.";
    destroyCharts(state.chartsFull);
    els.overlayCharts.innerHTML = '';
  }
}

/* ==========================================================================
   15. SÉLECTION STATION
   ========================================================================== */

async function selectStation(id) {
  const station = STATIONS.find((s) => s.id === id);
  if (!station) return;

  state.selected = id;
  renderList();

  const cached = state.readings.get(id);
  renderDetail(station, cached);

  try {
    const timeRange = calculateTimeRange(CONFIG.hoursPerDay);
    const maxPoints = estimateMaxPoints(CONFIG.hoursPerDay);

    const cacheKey = `history24h:${id}`;
    let payload = cacheGet(cacheKey);

    if (!payload) {
      const data = await fetchFeedsWithTimeRange(station, timeRange, maxPoints);
      payload = cacheSet(
        cacheKey,
        (data.feeds || []).map((f) => normalizeFeed(f, station))
      );
    }

    if (!payload.length) {
      els.status.textContent = `Aucune donnée sur les 24 dernières heures pour ${station.name}.`;
      destroyCharts(state.chartsDefault);
      els.charts.innerHTML = '';
      return;
    }

    renderDetail(station, payload.at(-1));
    drawCharts(els.charts, state.chartsDefault, payload, station, '', timeRange);
  } catch (err) {
    console.error('[history24h]', err);
    els.status.textContent = `Historique 24h indisponible pour ${station.name}.`;
    destroyCharts(state.chartsDefault);
    els.charts.innerHTML = '';
  }
}

/* ==========================================================================
   16. RAFRAÎCHISSEMENT GLOBAL
   ========================================================================== */

async function refreshAll() {
  const outcomes = await Promise.allSettled(
    STATIONS.map(async (station) => {
      const cached = cacheGet(`latest:${station.id}`);
      if (cached) return { id: station.id, reading: cached };

      const data = await fetchLatestFeed(station);
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

  if (state.selected) {
    const station = STATIONS.find((s) => s.id === state.selected);
    if (station) renderDetail(station, state.readings.get(station.id));
  }
}

/* ==========================================================================
   17. ÉVÉNEMENTS ET DÉMARRAGE
   ========================================================================== */

els.btnHistory.addEventListener('click', openOverlay);
els.overlayClose.addEventListener('click', closeOverlay);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.overlayVisible) closeOverlay();
});

els.overlay.addEventListener('click', (e) => {
  if (e.target === els.overlay) closeOverlay();
});

renderRangeButtons();
refreshAll();
setInterval(refreshAll, CONFIG.refreshMs);

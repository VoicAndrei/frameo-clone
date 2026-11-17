'use strict';
/**
 * weather.js — current conditions for the frame's clock overlay.
 *
 * SOURCE
 * ------
 * Open-Meteo (https://open-meteo.com). Chosen because it needs no API key, no
 * account and no payment, and its non-commercial tier has no hard request cap.
 * That matters here: the deployment rule for this project is that nothing may
 * cost money or require a login that can expire unattended in a grandparent's
 * living room.
 *
 * WHY THIS IS PROXIED INSTEAD OF FETCHED BY THE TABLET
 * ---------------------------------------------------
 *   - One request per REFRESH_MS for the whole house, not one per frame.
 *   - The frames keep a single origin. They already trust this server; they do
 *     not have to reach a third party, and no third party sees the frames.
 *   - A failure here is invisible: the endpoint serves the last good reading
 *     for up to STALE_MS, and the overlay simply hides the weather if there is
 *     nothing at all. The clock never depends on this.
 *
 * The response is deliberately tiny and pre-digested — the frame does no unit
 * conversion and no code mapping beyond picking an icon.
 *
 * LOCATION
 * --------
 * WEATHER_LAT / WEATHER_LON in .env. Weather is OFF until both are set. Set
 * them to the grandparents' town: the reading should describe what they see out
 * of the window, not where the server happens to live.
 */

const REFRESH_MS = 15 * 60 * 1000;  // how often we go to Open-Meteo
const STALE_MS = 6 * 60 * 60 * 1000; // how long a cached reading may still be served
const FETCH_TIMEOUT_MS = 8000;
const RETRY_AFTER_ERROR_MS = 60 * 1000;

function num(raw, fallback) {
  // An UNSET env var must fall back, not become 0. Number('') is 0 and 0 is
  // finite, so a naive Number.isFinite check silently relocates the frame to
  // 0N 0E (the Atlantic) and reports plausible-looking sea temperatures.
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} deps
 * @param {NodeJS.ProcessEnv} deps.env
 * @param {(msg: string, fields?: object) => void} [deps.logWarn]
 * @param {(msg: string, fields?: object) => void} [deps.logInfo]
 */
function createWeatherService({ env = process.env, logWarn = () => {}, logInfo = () => {} } = {}) {
  const lat = num(env.WEATHER_LAT, NaN);
  const lon = num(env.WEATHER_LON, NaN);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);
  const enabled = hasLocation
    && String(env.WEATHER_ENABLED ?? 'true').toLowerCase() !== 'false';

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${encodeURIComponent(lat.toFixed(4))}`
    + `&longitude=${encodeURIComponent(lon.toFixed(4))}`
    + '&current=temperature_2m,weather_code,is_day'
    + '&timezone=auto';

  /** @type {{tempC: number, code: number, isDay: boolean, observedAt: string}|null} */
  let cached = null;
  let cachedAt = 0;
  let nextAttemptAt = 0;
  let inFlight = null;

  async function fetchFresh() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const doc = await res.json();
      const cur = doc && doc.current;
      if (!cur || !Number.isFinite(Number(cur.temperature_2m))) {
        throw new Error('open-meteo returned no current temperature');
      }
      cached = {
        tempC: Math.round(Number(cur.temperature_2m)),
        code: Number.isFinite(Number(cur.weather_code)) ? Number(cur.weather_code) : 0,
        isDay: Number(cur.is_day) !== 0,
        observedAt: String(cur.time || ''),
      };
      cachedAt = Date.now();
      nextAttemptAt = cachedAt + REFRESH_MS;
      return cached;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Never throws. Returns the freshest reading available, or null. */
  async function current() {
    if (!enabled) return null;
    const now = Date.now();
    if (cached && now < nextAttemptAt) return cached;
    if (!inFlight) {
      inFlight = fetchFresh()
        .catch((err) => {
          // Back off, then keep serving the previous reading until it goes stale.
          nextAttemptAt = Date.now() + RETRY_AFTER_ERROR_MS;
          logWarn('weather.fetch_failed', {
            detail: err && err.message ? err.message : String(err),
            servingCached: Boolean(cached),
          });
          return null;
        })
        .finally(() => { inFlight = null; });
    }
    const fresh = await inFlight;
    if (fresh) return fresh;
    if (cached && Date.now() - cachedAt < STALE_MS) return cached;
    return null;
  }

  /** GET /api/weather -> { weather: {...} | null }. Always 200; never blocks a frame. */
  async function handleRequest(req, res, sendJson) {
    const reading = await current();
    // A short cache header keeps a reloading frame from stampeding this handler.
    res.setHeader('cache-control', 'public, max-age=300');
    sendJson(res, 200, {
      weather: reading,
      location: { lat, lon },
    });
  }

  if (enabled) {
    logInfo('weather.configured', { lat, lon, refreshMinutes: REFRESH_MS / 60000 });
  }

  return { current, handleRequest, enabled, lat, lon };
}

module.exports = { createWeatherService };

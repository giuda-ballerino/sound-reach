/** Geodesy helpers on a spherical Earth (good to ~0.3% at these distances). */

export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6_371_000;
const rad = (x: number) => (x * Math.PI) / 180;
const deg = (x: number) => (x * 180) / Math.PI;

/** Parse "38.1058, 12.7230" (also with ';' or space, and decimal commas). */
export function parseLatLon(text: string): LatLon | null {
  const m = String(text)
    .trim()
    .match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(',', '.'));
  const lon = parseFloat(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function formatLatLon(p: LatLon, digits = 5): string {
  return `${p.lat.toFixed(digits)}, ${p.lon.toFixed(digits)}`;
}

/** Great‑circle distance (m) and initial bearing (deg from north) from a to b. */
export function distanceBearing(a: LatLon, b: LatLon): { distance: number; bearing: number } {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const dφ = rad(b.lat - a.lat);
  const dλ = rad(b.lon - a.lon);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const distance = 2 * R * Math.asin(Math.sqrt(h));
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  const bearing = (deg(Math.atan2(y, x)) + 360) % 360;
  return { distance, bearing };
}

/** Point reached from `from` after `distance` m along `bearing` deg. */
export function destination(from: LatLon, bearingDeg: number, distance: number): LatLon {
  const φ1 = rad(from.lat);
  const λ1 = rad(from.lon);
  const θ = rad(bearingDeg);
  const δ = distance / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(bearingDeg: number): string {
  return POINTS[Math.round(bearingDeg / 22.5) % 16];
}

export function formatDistance(m: number): string {
  if (m >= 10_000) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

/** Smallest angle between two bearings, 0..180. */
export function angleBetweenBearings(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

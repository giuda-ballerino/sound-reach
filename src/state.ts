import { DEFAULT_RIG, type RigParams } from './acoustics';
import type { LatLon } from './geo';
import type { ZoneMode } from './zones';

export interface Receptor extends LatLon {
  id: string;
  name: string;
}

export interface Scenario {
  version: 1;
  name: string;
  stage: LatLon | null;
  rig: RigParams;
  zoneMode: ZoneMode;
  /** Night limit (dB(A) at the façade) used in 'legal' mode. */
  limitDb: number;
  receptors: Receptor[];
  /** Base map layer id. */
  layer: 'satellite' | 'streets';
  /** Draw the dashed bass contour. Off by default: bass carries for kilometres and swamps the map. */
  showBass: boolean;
}

export const LIMITS: { value: number; label: string }[] = [
  { value: 45, label: '45 · class II residential, night' },
  { value: 50, label: '50 · class III mixed, night' },
  { value: 55, label: '55 · class IV intense activity, night' },
  { value: 60, label: '60 · no acoustic zoning (DPCM 1991), night' },
  { value: 65, label: '65 · typical deroga ceiling' },
  { value: 70, label: '70 · generous deroga ceiling' },
];

export function newScenario(): Scenario {
  return {
    version: 1,
    name: '',
    stage: null,
    rig: { ...DEFAULT_RIG },
    zoneMode: 'legal',
    limitDb: 60,
    receptors: [],
    layer: 'satellite',
    showBass: false,
  };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const CURRENT_KEY = 'sound-reach.current';
const LIBRARY_KEY = 'sound-reach.library';

export function loadCurrent(): Scenario | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveCurrent(s: Scenario): void {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: nothing to do */
  }
}

export function loadLibrary(): Record<string, Scenario> {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const lib = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Record<string, Scenario> = {};
    for (const [k, v] of Object.entries(lib)) {
      const s = sanitize(v);
      if (s) out[k] = s;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLibrary(lib: Record<string, Scenario>): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
  } catch {
    /* ignore */
  }
}

/** Accept any JSON that looks like a scenario and fill the gaps with defaults. */
export function sanitize(input: unknown): Scenario | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const base = newScenario();
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const rigIn = (o.rig && typeof o.rig === 'object' ? o.rig : {}) as Record<string, unknown>;
  const rig: RigParams = {
    maxLevelAt10m: num(rigIn.maxLevelAt10m, base.rig.maxLevelAt10m),
    volumePct: num(rigIn.volumePct, base.rig.volumePct),
    bassExcess: num(rigIn.bassExcess, base.rig.bassExcess),
    aimDeg: num(rigIn.aimDeg, base.rig.aimDeg),
    directional: typeof rigIn.directional === 'boolean' ? rigIn.directional : base.rig.directional,
    subs: rigIn.subs === 'cardioid' ? 'cardioid' : 'omni',
    night: typeof rigIn.night === 'boolean' ? rigIn.night : base.rig.night,
    softGround: typeof rigIn.softGround === 'boolean' ? rigIn.softGround : base.rig.softGround,
  };
  const stageIn = o.stage as Record<string, unknown> | null | undefined;
  const stage =
    stageIn && typeof stageIn === 'object' && Number.isFinite(stageIn.lat) && Number.isFinite(stageIn.lon)
      ? { lat: Number(stageIn.lat), lon: Number(stageIn.lon) }
      : null;
  const receptors: Receptor[] = Array.isArray(o.receptors)
    ? (o.receptors as Record<string, unknown>[])
        .filter((r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lon))
        .map((r) => ({
          id: typeof r.id === 'string' ? r.id : uid(),
          name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Receptor',
          lat: Number(r.lat),
          lon: Number(r.lon),
        }))
    : [];
  const zoneMode: ZoneMode = o.zoneMode === 'audibility' || o.zoneMode === 'rings' ? o.zoneMode : 'legal';
  return {
    version: 1,
    name: typeof o.name === 'string' ? o.name : '',
    stage,
    rig,
    zoneMode,
    limitDb: num(o.limitDb, base.limitDb),
    receptors,
    layer: o.layer === 'streets' ? 'streets' : 'satellite',
    showBass: o.showBass === true,
  };
}

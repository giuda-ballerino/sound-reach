import { DEFAULT_RIG, type RigParams } from './acoustics';
import { CONDITION_PRESETS, defaultConditions, type ConditionPreset, type Conditions } from './conditions';
import type { LatLon } from './geo';
import { DEFAULT_RECEIVER_HEIGHT_M, DEFAULT_SOURCE_HEIGHT_M } from './terrain';
import type { OmnidirectionalWind } from './wind';
import type { ZoneMode } from './zones';

export interface Receptor extends LatLon {
  id: string;
  name: string;
}

export interface TerrainSettings {
  /** Subtract terrain shielding from the predicted levels. */
  enabled: boolean;
  /** Height of the stacks above the ground at the stage, metres. */
  sourceHeightM: number;
  /** Height of the receiver above the ground, metres. A first‑floor window is about 4 m. */
  receiverHeightM: number;
}

export const DEFAULT_TERRAIN: TerrainSettings = {
  enabled: true,
  sourceHeightM: DEFAULT_SOURCE_HEIGHT_M,
  receiverHeightM: DEFAULT_RECEIVER_HEIGHT_M,
};

/** Bumped to 2 when weather conditions moved out of the rig. */
export const SCENARIO_VERSION = 2;

export interface Scenario {
  version: typeof SCENARIO_VERSION;
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
  terrain: TerrainSettings;
  conditions: Conditions;
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
    version: SCENARIO_VERSION,
    name: '',
    stage: null,
    rig: { ...DEFAULT_RIG },
    zoneMode: 'legal',
    limitDb: 60,
    receptors: [],
    layer: 'satellite',
    showBass: false,
    terrain: { ...DEFAULT_TERRAIN },
    conditions: defaultConditions(),
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
  // Scenarios saved before terrain existed have no `terrain` key: give them the defaults.
  const terrainIn = (o.terrain && typeof o.terrain === 'object' ? o.terrain : {}) as Record<string, unknown>;
  const height = (v: unknown, d: number) => {
    const n = num(v, d);
    return n >= 0 && n <= 200 ? n : d;
  };
  const terrain: TerrainSettings = {
    enabled: typeof terrainIn.enabled === 'boolean' ? terrainIn.enabled : DEFAULT_TERRAIN.enabled,
    sourceHeightM: height(terrainIn.sourceHeightM, DEFAULT_TERRAIN.sourceHeightM),
    receiverHeightM: height(terrainIn.receiverHeightM, DEFAULT_TERRAIN.receiverHeightM),
  };
  return {
    version: SCENARIO_VERSION,
    name: typeof o.name === 'string' ? o.name : '',
    stage,
    rig,
    zoneMode,
    limitDb: num(o.limitDb, base.limitDb),
    receptors,
    layer: o.layer === 'streets' ? 'streets' : 'satellite',
    showBass: o.showBass === true,
    terrain,
    conditions: readConditions(o, rigIn),
  };
}

const PRESETS: ConditionPreset[] = ['typical', 'worst', 'favourable', 'custom'];

/**
 * Read the conditions block, migrating version 1 files on the way.
 *
 * Before version 2 the weather lived on the rig as two booleans. Those carry over as-is rather
 * than being thrown away, which means a migrated file can hold values that do not match any
 * preset — an old scenario with `night: true` is not a typical night. When that happens the
 * preset reads 'custom', so the control and the numbers agree instead of the panel claiming
 * 'Typical' over an inversion.
 */
function readConditions(o: Record<string, unknown>, rigIn: Record<string, unknown>): Conditions {
  const fallbackInversion = typeof rigIn.night === 'boolean' ? rigIn.night : CONDITION_PRESETS.typical.inversion;
  const fallbackGround = typeof rigIn.softGround === 'boolean' ? rigIn.softGround : CONDITION_PRESETS.typical.groundSoft;
  const legacy: Conditions = {
    ...CONDITION_PRESETS.typical,
    inversion: fallbackInversion,
    groundSoft: fallbackGround,
  };
  const typical = CONDITION_PRESETS.typical;
  if (!o.conditions || typeof o.conditions !== 'object') {
    const matchesTypical = legacy.inversion === typical.inversion && legacy.groundSoft === typical.groundSoft;
    return { ...legacy, preset: matchesTypical ? 'typical' : 'custom' };
  }

  const c = o.conditions as Record<string, unknown>;
  const n = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  const preset = PRESETS.includes(c.preset as ConditionPreset) ? (c.preset as ConditionPreset) : 'custom';
  // A named preset is defined by its own values, not by whatever was serialised next to it.
  if (preset !== 'custom') return { ...CONDITION_PRESETS[preset] };

  const wind = c.omnidirectionalWind;
  return {
    preset: 'custom',
    temperatureC: n(c.temperatureC, typical.temperatureC, -40, 60),
    humidityPct: n(c.humidityPct, typical.humidityPct, 1, 100),
    windSpeedMs: n(c.windSpeedMs, typical.windSpeedMs, 0, 50),
    // A bearing is modular, so wrap anything finite rather than rejecting 450° as out of range.
    windFromDeg: typeof c.windFromDeg === 'number' && Number.isFinite(c.windFromDeg)
      ? ((c.windFromDeg % 360) + 360) % 360
      : 0,
    inversion: typeof c.inversion === 'boolean' ? c.inversion : legacy.inversion,
    groundSoft: typeof c.groundSoft === 'boolean' ? c.groundSoft : legacy.groundSoft,
    ...(wind === 'downwind' || wind === 'upwind' ? { omnidirectionalWind: wind as OmnidirectionalWind } : {}),
  };
}

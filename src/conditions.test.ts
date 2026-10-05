import { describe, expect, it } from 'vitest';
import { DEFAULT_RIG, levelAt } from './acoustics';
import { CONDITION_PRESETS, WORST_CASE, applyPreset, defaultConditions, type Conditions } from './conditions';
import { SCENARIO_VERSION, newScenario, sanitize } from './state';

describe('presets', () => {
  it('describes a neutral September night as typical', () => {
    expect(CONDITION_PRESETS.typical).toMatchObject({
      temperatureC: 18,
      humidityPct: 75,
      windSpeedMs: 0,
      inversion: false,
      groundSoft: true,
    });
    expect(CONDITION_PRESETS.typical.omnidirectionalWind).toBeUndefined();
  });

  it('builds the worst case the way a permit forecast does', () => {
    // Downwind towards every bearing at once, an inversion, and hard reflecting ground.
    expect(CONDITION_PRESETS.worst).toMatchObject({
      temperatureC: 15,
      humidityPct: 90,
      inversion: true,
      groundSoft: false,
      omnidirectionalWind: 'downwind',
    });
    expect(WORST_CASE).toBe(CONDITION_PRESETS.worst);
  });

  it('builds the favourable case as the opposite envelope', () => {
    expect(CONDITION_PRESETS.favourable).toMatchObject({
      temperatureC: 25,
      humidityPct: 35,
      windSpeedMs: 5,
      inversion: false,
      omnidirectionalWind: 'upwind',
    });
  });

  it('orders the three presets as loud, middling and quiet at a real receptor', () => {
    const rig = { ...DEFAULT_RIG, directional: false };
    const at = (c: Conditions) => levelAt(rig, c, 800).la;
    expect(at(CONDITION_PRESETS.worst)).toBeGreaterThan(at(CONDITION_PRESETS.typical));
    expect(at(CONDITION_PRESETS.typical)).toBeGreaterThan(at(CONDITION_PRESETS.favourable));
  });
});

describe('applyPreset', () => {
  it('replaces everything when a named preset is chosen', () => {
    const custom: Conditions = { ...defaultConditions(), preset: 'custom', temperatureC: 30, windSpeedMs: 9 };
    expect(applyPreset('worst', custom)).toEqual(CONDITION_PRESETS.worst);
  });

  it('keeps the current values when switching to custom, and drops the fiction', () => {
    const next = applyPreset('custom', { ...CONDITION_PRESETS.worst });
    expect(next.preset).toBe('custom');
    expect(next.temperatureC).toBe(15);
    // Downwind in every direction at once is a convention, not something a user can dial in.
    expect(next.omnidirectionalWind).toBeUndefined();
  });
});

describe('scenario migration', () => {
  it('starts new scenarios at version 2 on the typical preset', () => {
    const s = newScenario();
    expect(s.version).toBe(SCENARIO_VERSION);
    expect(s.conditions).toEqual(CONDITION_PRESETS.typical);
  });

  it('carries a version 1 file across, moving the weather off the rig', () => {
    const v1 = {
      version: 1,
      name: 'old',
      stage: { lat: 38, lon: 12 },
      rig: { maxLevelAt10m: 110, volumePct: 80, bassExcess: 15, aimDeg: 90, directional: true, subs: 'omni', night: true, softGround: false },
      zoneMode: 'legal',
      limitDb: 55,
      receptors: [],
      layer: 'satellite',
      showBass: false,
    };
    const s = sanitize(v1);
    expect(s?.version).toBe(SCENARIO_VERSION);
    expect(s?.conditions.inversion).toBe(true);
    expect(s?.conditions.groundSoft).toBe(false);
    // The old flags no longer match a neutral night, so the control must not claim they do.
    expect(s?.conditions.preset).toBe('custom');
    // Everything else survives, and the rig has shed the two weather booleans.
    expect(s?.rig).toEqual({ maxLevelAt10m: 110, volumePct: 80, bassExcess: 15, aimDeg: 90, directional: true, subs: 'omni' });
    expect(s?.limitDb).toBe(55);
  });

  it('calls a version 1 file typical when its flags already match a neutral night', () => {
    const s = sanitize({ version: 1, rig: { night: false, softGround: true } });
    expect(s?.conditions.preset).toBe('typical');
    expect(s?.conditions).toEqual(CONDITION_PRESETS.typical);
  });

  it('fills in the defaults for a file with no weather at all', () => {
    // Nothing to migrate and nothing to contradict the preset, so it reads as a typical night.
    expect(sanitize({})?.conditions).toEqual(CONDITION_PRESETS.typical);
    expect(sanitize({ rig: {} })?.conditions.inversion).toBe(false);
  });

  it('reloads a named preset from its own definition, not from stale serialised fields', () => {
    const s = sanitize({ conditions: { preset: 'worst', temperatureC: 99, humidityPct: 1, inversion: false } });
    expect(s?.conditions).toEqual(CONDITION_PRESETS.worst);
  });

  it('keeps a custom block and rejects nonsense inside it', () => {
    const s = sanitize({
      conditions: {
        preset: 'custom',
        temperatureC: 22,
        humidityPct: 400,
        windSpeedMs: 3.5,
        windFromDeg: 450,
        inversion: true,
        groundSoft: false,
        omnidirectionalWind: 'sideways',
      },
    });
    expect(s?.conditions.temperatureC).toBe(22);
    expect(s?.conditions.humidityPct).toBe(75);
    expect(s?.conditions.windSpeedMs).toBe(3.5);
    expect(s?.conditions.windFromDeg).toBe(90);
    expect(s?.conditions.inversion).toBe(true);
    expect(s?.conditions.omnidirectionalWind).toBeUndefined();
  });

  it('survives a round trip through JSON', () => {
    const s = newScenario();
    s.conditions = { ...CONDITION_PRESETS.favourable };
    expect(sanitize(JSON.parse(JSON.stringify(s)))?.conditions).toEqual(CONDITION_PRESETS.favourable);
  });
});

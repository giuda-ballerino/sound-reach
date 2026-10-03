import './style.css';
import { levelAt, reachDistance, sourceLevel } from './acoustics';
import { compass, distanceBearing, formatDistance, formatLatLon, parseLatLon, type LatLon } from './geo';
import { SoundMap, escapeHtml } from './map';
import { LIMITS, loadCurrent, loadLibrary, newScenario, sanitize, saveCurrent, saveLibrary, uid, type Scenario } from './state';
import { AUDIBILITY_BANDS, RING_LEVELS, legalBands } from './zones';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let scenario: Scenario = loadCurrent() ?? newScenario();
let fitPending = true;

const soundMap = new SoundMap($('map'), {
  onStageMoved(p) {
    scenario.stage = p;
    render();
  },
  onAimChanged(deg) {
    scenario.rig.aimDeg = deg;
    render();
  },
  onReceptorMoved(id, p) {
    const r = scenario.receptors.find((x) => x.id === id);
    if (r) Object.assign(r, p);
    render();
  },
  onReceptorAdded(p) {
    const name = $<HTMLInputElement>('rec-name').value.trim() || `House ${scenario.receptors.length + 1}`;
    scenario.receptors.push({ id: uid(), name, ...p });
    $<HTMLInputElement>('rec-name').value = '';
    setClickMode('none');
    render();
  },
  onMapClickedForStage(p) {
    const first = !scenario.stage;
    scenario.stage = p;
    setClickMode('none');
    if (first) fitPending = true;
    render();
  },
});

// ---------- controls wiring ----------
const limitSel = $<HTMLSelectElement>('limit');
for (const l of LIMITS) {
  const o = document.createElement('option');
  o.value = String(l.value);
  o.textContent = l.label;
  limitSel.appendChild(o);
}

function setClickMode(mode: 'none' | 'stage' | 'receptor') {
  soundMap.clickMode = mode;
  const banner = $('pick-banner');
  banner.hidden = mode === 'none';
  banner.textContent = mode === 'stage' ? 'Click on the map to place the stage' : 'Click on the map to add a house';
  $('stage-pick').setAttribute('aria-pressed', String(mode === 'stage'));
  $('rec-pick').setAttribute('aria-pressed', String(mode === 'receptor'));
  $('map').style.cursor = mode === 'none' ? '' : 'crosshair';
  if (mode !== 'none' && window.innerWidth <= 820) $('side').classList.add('collapsed');
}

$('stage-pick').addEventListener('click', () => setClickMode(soundMap.clickMode === 'stage' ? 'none' : 'stage'));
$('rec-pick').addEventListener('click', () => setClickMode(soundMap.clickMode === 'receptor' ? 'none' : 'receptor'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setClickMode('none');
});

$<HTMLInputElement>('stage-input').addEventListener('change', (e) => {
  const p = parseLatLon((e.target as HTMLInputElement).value);
  if (p) {
    scenario.stage = p;
    fitPending = true;
    setClickMode('none');
    render();
  } else if ((e.target as HTMLInputElement).value.trim()) {
    (e.target as HTMLInputElement).setCustomValidity('Use "lat, lon"');
    (e.target as HTMLInputElement).reportValidity();
  }
});
$<HTMLInputElement>('stage-input').addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity(''));

$<HTMLInputElement>('volume').addEventListener('input', (e) => {
  scenario.rig.volumePct = Number((e.target as HTMLInputElement).value);
  render();
});

document.querySelectorAll<HTMLInputElement>('input[name="zone"]').forEach((r) =>
  r.addEventListener('change', () => {
    scenario.zoneMode = r.value as Scenario['zoneMode'];
    render();
  }),
);
document.querySelectorAll<HTMLInputElement>('input[name="layer"]').forEach((r) =>
  r.addEventListener('change', () => {
    scenario.layer = r.value as Scenario['layer'];
    soundMap.setLayer(scenario.layer);
    persist();
  }),
);
limitSel.addEventListener('change', () => {
  scenario.limitDb = Number(limitSel.value);
  render();
});

$<HTMLInputElement>('aim').addEventListener('input', (e) => {
  scenario.rig.aimDeg = Number((e.target as HTMLInputElement).value);
  render();
});
$<HTMLInputElement>('directional').addEventListener('change', (e) => {
  scenario.rig.directional = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLSelectElement>('subs').addEventListener('change', (e) => {
  scenario.rig.subs = (e.target as HTMLSelectElement).value as Scenario['rig']['subs'];
  render();
});
$<HTMLInputElement>('night').addEventListener('change', (e) => {
  scenario.rig.night = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>('show-bass').addEventListener('change', (e) => {
  scenario.showBass = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>('soft').addEventListener('change', (e) => {
  scenario.rig.softGround = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>('max').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 60 && v < 150) scenario.rig.maxLevelAt10m = v;
  render();
});
$<HTMLInputElement>('bass').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v >= 0 && v <= 30) scenario.rig.bassExcess = v;
  render();
});

$('rec-add').addEventListener('click', () => {
  const pos = parseLatLon($<HTMLInputElement>('rec-pos').value);
  const posEl = $<HTMLInputElement>('rec-pos');
  if (!pos) {
    posEl.setCustomValidity('Use "lat, lon"');
    posEl.reportValidity();
    return;
  }
  posEl.setCustomValidity('');
  const name = $<HTMLInputElement>('rec-name').value.trim() || `House ${scenario.receptors.length + 1}`;
  scenario.receptors.push({ id: uid(), name, ...pos });
  $<HTMLInputElement>('rec-name').value = '';
  posEl.value = '';
  render();
});
$<HTMLInputElement>('rec-pos').addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity(''));
$('rec-clear').addEventListener('click', () => {
  scenario.receptors = [];
  render();
});
$('rec-table').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) {
    scenario.receptors = scenario.receptors.filter((r) => r.id !== del.dataset.del);
    render();
    return;
  }
  const focus = t.closest<HTMLElement>('[data-focus]');
  if (focus) soundMap.focusReceptor(focus.dataset.focus!);
});

// Scenarios
$('sc-save').addEventListener('click', () => {
  const name = $<HTMLInputElement>('sc-name').value.trim();
  if (!name) {
    $<HTMLInputElement>('sc-name').focus();
    return;
  }
  const lib = loadLibrary();
  lib[name] = { ...scenario, name };
  saveLibrary(lib);
  renderLibrary();
});
$('sc-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ ...scenario, name: scenario.name || $<HTMLInputElement>('sc-name').value }, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sound-reach-${(scenario.name || 'scenario').replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$<HTMLInputElement>('sc-import').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const s = sanitize(JSON.parse(await file.text()));
    if (s) {
      scenario = s;
      fitPending = true;
      $<HTMLInputElement>('sc-name').value = s.name;
      soundMap.setLayer(s.layer);
      render();
    }
  } catch {
    /* invalid file: ignore */
  }
  (e.target as HTMLInputElement).value = '';
});

function renderLibrary() {
  const lib = loadLibrary();
  const box = $('sc-list');
  box.innerHTML = '';
  const names = Object.keys(lib).sort();
  if (!names.length) {
    box.innerHTML = '<span class="hint">No saved scenarios yet.</span>';
    return;
  }
  for (const n of names) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const load = document.createElement('button');
    load.textContent = n;
    load.title = 'Load';
    load.addEventListener('click', () => {
      scenario = { ...lib[n] };
      fitPending = true;
      $<HTMLInputElement>('sc-name').value = n;
      soundMap.setLayer(scenario.layer);
      render();
    });
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = `Delete ${n}`;
    x.addEventListener('click', () => {
      delete lib[n];
      saveLibrary(lib);
      renderLibrary();
    });
    chip.append(load, x);
    box.appendChild(chip);
  }
}

$('side-toggle').addEventListener('click', () => {
  const side = $('side');
  side.classList.toggle('collapsed');
  $('side-toggle').setAttribute('aria-expanded', String(!side.classList.contains('collapsed')));
});

// ---------- render ----------
function persist() {
  saveCurrent(scenario);
}

function render() {
  const s = scenario;
  const p = s.rig;

  // Controls reflect state
  $<HTMLInputElement>('stage-input').value = s.stage ? formatLatLon(s.stage) : '';
  $<HTMLInputElement>('volume').value = String(p.volumePct);
  $('volume-pct').textContent = `${p.volumePct}%`;
  $('l10').textContent = sourceLevel(p).toFixed(0);
  document.querySelectorAll<HTMLInputElement>('input[name="zone"]').forEach((r) => (r.checked = r.value === s.zoneMode));
  document.querySelectorAll<HTMLInputElement>('input[name="layer"]').forEach((r) => (r.checked = r.value === s.layer));
  limitSel.value = String(s.limitDb);
  $('limit-wrap').hidden = s.zoneMode !== 'legal';
  $<HTMLInputElement>('aim').value = String(p.aimDeg);
  $('aim-val').textContent = `${p.aimDeg}° ${compass(p.aimDeg)}`;
  $<HTMLInputElement>('directional').checked = p.directional;
  $<HTMLSelectElement>('subs').value = p.subs;
  $<HTMLInputElement>('night').checked = p.night;
  $<HTMLInputElement>('soft').checked = p.softGround;
  $<HTMLInputElement>('show-bass').checked = s.showBass;
  $<HTMLInputElement>('max').value = String(p.maxLevelAt10m);
  $<HTMLInputElement>('bass').value = String(p.bassExcess);
  $<HTMLInputElement>('aim').disabled = !p.directional;
  $<HTMLSelectElement>('subs').disabled = !p.directional;

  // Legend
  const legend = $('legend');
  legend.innerHTML = '';
  const bands = s.zoneMode === 'legal' ? legalBands(s.limitDb) : s.zoneMode === 'audibility' ? AUDIBILITY_BANDS : null;
  if (bands) {
    for (const b of bands) {
      const li = document.createElement('li');
      li.style.setProperty('--c', `var(--zone-${b.tone})`);
      li.textContent = b.label;
      legend.appendChild(li);
    }
    if (s.showBass) {
      const bass = document.createElement('li');
      bass.className = 'line';
      bass.style.setProperty('--c', 'var(--zone-bass)');
      bass.textContent = `dashed: bass band at ${Math.max(...bands.map((b) => b.lower)) + 15} dB(C), where the thump is felt`;
      legend.appendChild(bass);
    }
  } else {
    const li = document.createElement('li');
    li.className = 'line';
    li.style.setProperty('--c', '#bbb');
    li.textContent = `A‑weighted contours at ${RING_LEVELS.join(', ')} dB(A), in the direction the stacks face`;
    legend.appendChild(li);
  }

  // KPIs
  const target = s.zoneMode === 'legal' ? s.limitDb : s.zoneMode === 'audibility' ? 45 : 60;
  $('k-reach-label').textContent = s.zoneMode === 'legal' ? `${s.limitDb} dB(A)` : s.zoneMode === 'audibility' ? '45 dB(A), clearly audible' : '60 dB(A)';
  if (s.stage) {
    const front = reachDistance(p, target, p.aimDeg);
    const back = reachDistance(p, target, p.aimDeg + 180);
    $('k-reach').textContent = formatDistance(front);
    $('k-reach-hint').textContent = p.directional ? `in front · ${formatDistance(back)} behind the stacks` : 'in every direction';
  } else {
    $('k-reach').textContent = '—';
    $('k-reach-hint').textContent = 'place the stage on the map';
  }

  // Receptor table + nearest
  const tb = $('rec-table').querySelector('tbody')!;
  tb.innerHTML = '';
  let nearest: { name: string; d: number; la: number; lc: number } | null = null;
  if (s.stage) {
    const rows = s.receptors
      .map((r) => {
        const { distance, bearing } = distanceBearing(s.stage as LatLon, r);
        const lv = levelAt(p, distance, bearing);
        return { r, distance, bearing, lv };
      })
      .sort((a, b) => a.distance - b.distance);
    for (const { r, distance, bearing, lv } of rows) {
      if (!nearest || distance < nearest.d) nearest = { name: r.name, d: distance, la: lv.la, lc: lv.lc };
      const tone = s.zoneMode === 'legal' ? (lv.la >= s.limitDb ? 'critical' : lv.la >= s.limitDb - 5 ? 'warning' : 'fine') : lv.la >= 60 ? 'critical' : lv.la >= 45 ? 'warning' : 'fine';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><button class="link" data-focus="${r.id}" title="Show on map"><span class="pill" style="background:var(--zone-${tone})"></span>${escapeHtml(r.name)}</button><div class="hint" style="margin:0">${compass(bearing)} · ${formatLatLon(r, 4)}</div></td><td class="num">${formatDistance(distance)}</td><td class="num">${lv.la.toFixed(0)}</td><td class="num">${lv.lc.toFixed(0)}</td><td><button class="btn small ghost" data-del="${r.id}" title="Remove">×</button></td>`;
      tb.appendChild(tr);
    }
  }
  if (!tb.children.length) {
    tb.innerHTML = `<tr><td colspan="5" class="hint" style="margin:0">${s.stage ? 'Add the nearest houses, the village edge, the campsite reception.' : 'Place the stage first.'}</td></tr>`;
  }
  if (nearest) {
    $('k-near').textContent = `${nearest.la.toFixed(0)} dB(A)`;
    $('k-near-hint').textContent = `${nearest.name}, ${formatDistance(nearest.d)} · bass ${nearest.lc.toFixed(0)} dB(C)`;
  } else {
    $('k-near').textContent = '—';
    $('k-near-hint').textContent = 'add a house';
  }

  soundMap.render(s);
  if (fitPending && s.stage) {
    soundMap.fitScenario(s);
    fitPending = false;
  }
  persist();
}

soundMap.setLayer(scenario.layer);
$<HTMLInputElement>('sc-name').value = scenario.name;
renderLibrary();
render();
if (!scenario.stage) setClickMode('stage');

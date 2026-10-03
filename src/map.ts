import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { levelAt, type Levels } from './acoustics';
import { destination, distanceBearing, formatDistance, type LatLon } from './geo';
import { NO_SHIELDING } from './terrain';
import type { Receptor, Scenario } from './state';
import {
  AUDIBILITY_BANDS,
  RING_LEVELS,
  bandPolygons,
  contourRing,
  flatGround,
  legalBands,
  maxReach,
  shieldedReach,
  type ShieldingAt,
  type ZoneBand,
} from './zones';

/** What the renderer knows about terrain. Omit it entirely for flat ground. */
export interface TerrainOverlay {
  /** Applied to the zone contours. `flatGround` until the user asks for terrain on the zones. */
  shieldingAt: ShieldingAt;
  /** dB to subtract at each receptor, by receptor id. Missing means none known. */
  receptors: Map<string, Levels>;
}

const FLAT: TerrainOverlay = { shieldingAt: flatGround, receptors: new Map() };

export interface MapCallbacks {
  onStageMoved(p: LatLon): void;
  onAimChanged(deg: number): void;
  onReceptorMoved(id: string, p: LatLon): void;
  onReceptorAdded(p: LatLon): void;
  onMapClickedForStage(p: LatLon): void;
}

const toLL = (p: LatLon): L.LatLngExpression => [p.lat, p.lon];
const fromLL = (ll: L.LatLng): LatLon => ({ lat: ll.lat, lon: ll.lng });

function toneColor(tone: ZoneBand['tone'] | 'ring' | 'bass'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--zone-${tone}`).trim() || '#888';
}

export type ClickMode = 'none' | 'stage' | 'receptor';

export class SoundMap {
  readonly map: L.Map;
  private layers: Record<Scenario['layer'], L.TileLayer>;
  private zones = L.layerGroup();
  private rings = L.layerGroup();
  private receptorLayer = L.layerGroup();
  private stageMarker: L.Marker | null = null;
  private aimHandle: L.Marker | null = null;
  private aimLine: L.Polyline | null = null;
  private receptorMarkers = new Map<string, L.Marker>();
  clickMode: ClickMode = 'none';

  constructor(el: HTMLElement, private cb: MapCallbacks) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([37.6, 13.3], 8);
    this.layers = {
      satellite: L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      ),
      streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }),
    };
    this.layers.satellite.addTo(this.map);
    this.map.attributionControl.addAttribution(
      'Elevation <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Tilezen Terrain Tiles</a>' +
        ' (EU‑DEM © European Union/Copernicus, SRTM &amp; GMTED2010 courtesy USGS), <a href="https://open-meteo.com/">Open‑Meteo</a>',
    );
    L.control.scale({ metric: true, imperial: false }).addTo(this.map);
    this.zones.addTo(this.map);
    this.rings.addTo(this.map);
    this.receptorLayer.addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.clickMode === 'stage') this.cb.onMapClickedForStage(fromLL(e.latlng));
      else if (this.clickMode === 'receptor') this.cb.onReceptorAdded(fromLL(e.latlng));
    });
  }

  setLayer(id: Scenario['layer']) {
    for (const [k, layer] of Object.entries(this.layers)) {
      if (k === id) {
        if (!this.map.hasLayer(layer)) layer.addTo(this.map);
      } else if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
    }
  }

  fitTo(stage: LatLon, reachM: number, receptors: Receptor[]) {
    const pts: L.LatLngExpression[] = [toLL(stage)];
    for (const b of [0, 90, 180, 270]) pts.push(toLL(destination(stage, b, reachM)));
    for (const r of receptors) pts.push(toLL(r));
    this.map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
  }

  render(s: Scenario, terrain: TerrainOverlay = FLAT) {
    this.zones.clearLayers();
    this.rings.clearLayers();
    this.receptorLayer.clearLayers();
    this.receptorMarkers.clear();
    if (!s.stage) {
      this.stageMarker?.remove();
      this.stageMarker = null;
      this.aimHandle?.remove();
      this.aimHandle = null;
      this.aimLine?.remove();
      this.aimLine = null;
      return;
    }
    const stage = s.stage;
    const p = s.rig;
    const shieldingAt = terrain.shieldingAt;

    // Zones
    if (s.zoneMode === 'rings') {
      for (const lvl of RING_LEVELS) {
        const ring = contourRing(stage, p, lvl, 'la', shieldingAt);
        const poly = L.polygon(ring.map(toLL), {
          color: toneColor('ring'),
          weight: lvl === 60 ? 2.5 : 1.5,
          fill: false,
          dashArray: lvl <= 50 ? '6 5' : undefined,
        }).addTo(this.rings);
        const tip = destination(stage, p.aimDeg, shieldedReach(p, lvl, p.aimDeg, 'la', shieldingAt));
        L.marker(toLL(tip), {
          icon: L.divIcon({ className: 'ring-label', html: `${lvl} dB(A)`, iconSize: undefined }),
          interactive: false,
        }).addTo(this.rings);
        poly.bindTooltip(`${lvl} dB(A)`, { sticky: true });
      }
    } else {
      const bands = s.zoneMode === 'legal' ? legalBands(s.limitDb) : AUDIBILITY_BANDS;
      for (const { band, outer, hole } of bandPolygons(stage, p, bands, 'la', shieldingAt)) {
        const rings: L.LatLngExpression[][] = hole ? [outer.map(toLL), hole.map(toLL)] : [outer.map(toLL)];
        L.polygon(rings, {
          color: toneColor(band.tone),
          weight: 1.5,
          fillColor: toneColor(band.tone),
          fillOpacity: band.tone === 'faint' ? 0.12 : 0.22,
        })
          .bindTooltip(band.label, { sticky: true })
          .addTo(this.zones);
      }
      // Optional bass contour. Bass carries far: shown where the bass band is 15 dB above the
      // innermost A-weighted threshold, roughly where a dB(C) − dB(A) gap starts to be felt as a thump.
      if (s.showBass) {
        const innermost = Math.max(...bands.map((b) => b.lower));
        const bassDb = innermost + 15;
        L.polygon(contourRing(stage, p, bassDb, 'lc', shieldingAt).map(toLL), {
          color: toneColor('bass'),
          weight: 1.5,
          dashArray: '6 5',
          fill: false,
        })
          .bindTooltip(`bass band at ${bassDb} dB(C)`, { sticky: true })
          .addTo(this.zones);
      }
    }

    // Stage marker (draggable)
    if (!this.stageMarker) {
      this.stageMarker = L.marker(toLL(stage), {
        draggable: true,
        icon: L.divIcon({ className: 'stage-icon', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 1000,
      }).addTo(this.map);
      this.stageMarker.bindTooltip('Stage · drag to move', { direction: 'top', offset: [0, -10] });
      this.stageMarker.on('dragend', () => this.cb.onStageMoved(fromLL(this.stageMarker!.getLatLng())));
    } else {
      this.stageMarker.setLatLng(toLL(stage));
    }

    // Aim handle: a draggable point 25% of the way to the limit contour, in the aim direction
    const aimDist = Math.max(60, shieldedReach(p, s.zoneMode === 'legal' ? s.limitDb : 60, p.aimDeg, 'la', shieldingAt) * 0.25);
    const aimPoint = destination(stage, p.aimDeg, aimDist);
    if (!this.aimHandle) {
      this.aimHandle = L.marker(toLL(aimPoint), {
        draggable: true,
        icon: L.divIcon({ className: 'aim-icon', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] }),
        zIndexOffset: 900,
      }).addTo(this.map);
      this.aimHandle.bindTooltip('Stacks face this way · drag to turn', { direction: 'top', offset: [0, -8] });
      this.aimHandle.on('drag', () => {
        const { bearing } = distanceBearing(stage, fromLL(this.aimHandle!.getLatLng()));
        this.aimLine?.setLatLngs([toLL(stage), this.aimHandle!.getLatLng()]);
        this.aimHandle!.setTooltipContent(`Aim ${bearing.toFixed(0)}°`);
      });
      this.aimHandle.on('dragend', () => {
        const { bearing } = distanceBearing(stage, fromLL(this.aimHandle!.getLatLng()));
        this.cb.onAimChanged(Math.round(bearing));
      });
    } else {
      this.aimHandle.setLatLng(toLL(aimPoint));
    }
    if (!this.aimLine) {
      this.aimLine = L.polyline([toLL(stage), toLL(aimPoint)], { color: '#ffffff', weight: 3, opacity: 0.9 }).addTo(this.map);
    } else {
      this.aimLine.setLatLngs([toLL(stage), toLL(aimPoint)]);
    }
    if (!p.directional) {
      this.aimHandle.setOpacity(0.35);
      this.aimLine.setStyle({ opacity: 0.3 });
    } else {
      this.aimHandle.setOpacity(1);
      this.aimLine.setStyle({ opacity: 0.9 });
    }

    // Receptors. The shielded level is the one shown and coloured; the flat one is kept in
    // brackets so the terrain's contribution is visible.
    for (const r of s.receptors) {
      const { distance, bearing } = distanceBearing(stage, r);
      const shielding = terrain.receptors.get(r.id) ?? NO_SHIELDING;
      const lv = levelAt(p, distance, bearing, shielding);
      const flat = levelAt(p, distance, bearing);
      const limit = s.limitDb;
      const tone = s.zoneMode === 'legal' ? (lv.la >= limit ? 'critical' : lv.la >= limit - 5 ? 'warning' : 'fine') : lv.la >= 60 ? 'critical' : lv.la >= 45 ? 'warning' : 'fine';
      const m = L.marker(toLL(r), {
        draggable: true,
        icon: L.divIcon({
          className: `receptor-icon tone-${tone}`,
          html: `<span></span><label>${escapeHtml(r.name)} · ${lv.la.toFixed(0)} dB(A)</label>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(this.receptorLayer);
      const aside = (shielded: number, open: number) =>
        Math.abs(open - shielded) >= 1 ? ` <span class="muted">(flat ${open.toFixed(1)})</span>` : '';
      m.bindTooltip(
        `${escapeHtml(r.name)}<br>${formatDistance(distance)} · ${bearing.toFixed(0)}°<br>${lv.la.toFixed(1)} dB(A)${aside(
          lv.la,
          flat.la,
        )} · bass ${lv.lc.toFixed(1)} dB(C)${aside(lv.lc, flat.lc)}`,
        { direction: 'top', offset: [0, -8] },
      );
      m.on('dragend', () => this.cb.onReceptorMoved(r.id, fromLL(m.getLatLng())));
      this.receptorMarkers.set(r.id, m);
    }
  }

  /** Fit the view to the current scenario once (after load or when the stage is first placed). */
  fitScenario(s: Scenario, terrain: TerrainOverlay = FLAT) {
    if (!s.stage) return;
    const levels = s.zoneMode === 'legal' ? [s.limitDb - 10] : s.zoneMode === 'audibility' ? [35] : [45];
    this.fitTo(s.stage, maxReach(s.rig, levels, 'la', terrain.shieldingAt), s.receptors);
  }

  focusReceptor(id: string) {
    const m = this.receptorMarkers.get(id);
    if (m) {
      this.map.panTo(m.getLatLng());
      m.openTooltip();
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

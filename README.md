# Sound Reach

A map tool for choosing a festival site: place the stage, set the volume as a percentage of what the rig can do, and see how far the sound carries and which houses fall in the red. Built for a 4× Funktion-One Evo 2 / 8× F121 system, adjustable to any rig.

Static site: Vite + TypeScript + Leaflet. No backend, no keys. Map tiles come from Esri World Imagery (satellite) and OpenStreetMap (streets), ground elevations from open terrain tiles; everything else runs in the browser. Scenarios are kept in `localStorage` and can be exported/imported as JSON.

## Run locally

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for the acoustic model and geometry
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ locally
```

## Deploy on Cloudflare Pages

Push the repo to GitHub or GitLab, then in the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git.

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 20 or later (set `NODE_VERSION=20` in the environment variables if the default is older) |

`public/_headers` adds a few security headers; Cloudflare picks it up automatically. There is nothing to configure beyond that. Alternatively, `npx wrangler pages deploy dist` from the command line.

## How the model works

Everything is in `src/acoustics.ts` and is unit-tested in `src/acoustics.test.ts`.

The source is described by one number: the A-weighted level at 10 m in front of the stacks when the rig is at its maximum (`maxLevelAt10m`, default 112 dB(A)). The volume slider is a percentage of that maximum; each halving of the percentage is −10 dB, which is roughly "half as loud". From the 10 m reference the level falls by:

- spherical spreading, −20·log10(d/10), i.e. −6 dB per doubling of distance;
- air absorption from ISO 9613-1, for the chosen temperature and humidity — see [Weather](#weather);
- a ground term, −2 dB over soft ground beyond 200 m, phased in to 600 m;
- refraction by wind and temperature inversion, worth anything from +7 dB downwind to −15 dB in an upwind shadow — again [Weather](#weather);
- terrain shielding, when a ridge gets in the way — see [Terrain](#terrain) below.

Horizontal directivity: horn-loaded tops are modelled at 0 dB within ±30° of the aim, −6 dB at 90°, −12 dB behind. Subs are omnidirectional, or −10 dB behind when set to cardioid. Turning "directional" off gives a plain omnidirectional source.

Two bands are tracked. **dB(A)** is what every legal limit and derogation is measured in. The **bass band** (shown as dB(C), default 15 dB above the A-weighted figure for electronic music) is what neighbours notice at night; it is drawn as a dashed contour when enabled, because it carries for kilometres and otherwise swamps the map.

Zones can be read three ways:

- **Legal limit**: red where the predicted level at a façade is at or above the chosen night limit (Italian acoustic classes II–IV, the no-zoning transitional limit, or a derogation ceiling), amber within 5 dB of it, green 5–10 dB under.
- **Audibility**: loud / intrusive / clearly audible / faint, by level band.
- **dB rings**: plain contours at 90, 80, 70, 60, 50, 45 dB(A).

### What it does not model

Terrain shielding and weather are handled separately, in [Terrain](#terrain) and [Weather](#weather). Not modelled at all: buildings, walls, vegetation, reflections off water, humidity and temperature, multiple diffraction, and the actual Funktion-One polar response. A valley or a lake can carry sound further than predicted. Treat every number as ±5 dB and use the tool to compare sites and spot the houses that matter. A noise derogation application needs a *tecnico competente in acustica* with a proper forecast on the real terrain.

### Calibrating

Measure the rig once with an SPL meter (a phone app is fine for this purpose) at 10 m in front of the stacks at the volume you'd use, and type that figure into "Rig max" with the slider at 100%, or set the slider to the matching percentage. Everything else scales from it.

## Weather

Two nights at the same site can differ by more than 20 dB at the same house. Air absorption depends on temperature and humidity, and refraction by wind and temperature structure decides whether the sound is bent back down towards a village or lifted over it. A single number for "the weather" is the wrong shape for the decision this tool supports, so the model always carries two: the condition you selected, and the worst case, side by side everywhere.

### The three conditions

| | Typical | Worst (ISO) | Favourable |
| --- | --- | --- | --- |
| Temperature | 18 °C | 15 °C | 25 °C |
| Humidity | 75 % | 90 % | 35 % |
| Wind | none | downwind everywhere, 5 m/s | upwind everywhere, 5 m/s |
| Inversion | no | yes | no |
| Ground | soft | hard | soft |

**Typical** is a neutral September night in Sicily: damp, still, nothing conspiring. It is the honest default for "what will this probably sound like".

**Worst (ISO)** is not a forecast and will never happen. It is the enveloping convention ISO 9613-2 asks for in a permit calculation: every receptor treated as if it were downwind of the stage at once, under an inversion, over hard reflecting ground. No real wind blows towards every house simultaneously — but a derogation has to hold for whichever house the wind picks tonight, so the forecast has to cover all of them. This is why the worst case is drawn as a dashed outline on top of the zones even when you are looking at something else, why every receptor shows a second number, and why the receptor colours are keyed to it rather than to the selected condition.

**Favourable** is the opposite end of the same envelope, and exists for exactly one reason: to show how wide the envelope is. A site where typical and worst are 8 dB apart is a different proposition from one where they are 25 dB apart, even if the typical number is identical. Do not plan around it.

**Custom** takes your own temperature, humidity, wind speed and wind direction, with the inversion and ground switches. Drag the arrow in the top-right of the map to set which way the wind comes from.

### Air absorption

`src/absorption.ts` implements ISO 9613-1 properly: saturation vapour pressure from the triple-point expression, molar water-vapour concentration, oxygen and nitrogen relaxation frequencies, and the classical, rotational and vibrational terms. It is tested against the published tables to within 10 % at both 10 °C / 70 % and 20 °C / 70 %.

Absorption is strongly frequency-dependent and music is not a pure tone, so the coefficient has to be integrated over a spectrum. The model uses a fixed octave-band shape for a dance rig, in dB relative to the 1 kHz band:

| 63 | 125 | 250 | 500 | 1 k | 2 k | 4 k | 8 k |
| --- | --- | --- | --- | --- | --- | --- | --- |
| +10 | +7 | +4 | +1 | 0 | 0 | 0 | −4 |

**Absorption is computed per band at every distance, not as a rate.** Each band is attenuated by its own coefficient and the A-weighted total is re-summed at the distance in question, because the mix that arrives at 2 km is not the mix that left the stacks. The 4 and 8 kHz bands die first, and once they are gone there is nothing left for the air to take, so the A-weighted loss flattens off instead of growing linearly:

| | 100 m | 500 m | 1 km | 2 km | 3 km |
| --- | --- | --- | --- | --- | --- |
| Loss, dB(A) | 1.1 | 3.8 | 5.9 | 8.8 | 10.7 |
| As a flat 0.78 dB/100 m | 0.7 | 3.8 | 7.7 | 15.4 | 23.2 |

(18 °C / 75 %.) A per-100 m rate is only right at the distance it was fitted at. Treating absorption that way over-attenuated by 1.7 dB at 1 km and 12.5 dB at 3 km, which pulled the quiet contours — the 45 and 35 dB(A) audibility bands, the ones a neighbour actually cares about — hundreds of metres to kilometres inside where they belong.

The loss is evaluated thousands of times per contour, so it is precomputed per temperature and humidity at 64 log-spaced distances and interpolated in log-distance, which costs under 0.01 dB. The bass figure stays linear in distance: it is the 63 Hz coefficient, around 0.01 dB per 100 m. Air does essentially nothing to a kick drum, which is why bass is what carries to the next village.

`broadbandCoefficients` still reports the old single-rate fit at 500 m for reference: **0.798 dB per 100 m** at 20 °C / 70 %, matching the 0.8 the model used as a hard-coded constant before any of this existed, and ranging from 0.74 (15 °C / 90 %) to 0.90 (25 °C / 35 %). The propagation model no longer uses it.

### Wind and inversion

`src/wind.ts` turns wind and stability into one correction in dB. Wind speed increases with height, so downwind the ray paths curve back towards the ground and upwind they curve away and leave a shadow. A night-time inversion does the downwind thing in every direction at once, which is why complaints arrive at two in the morning.

- **θ** is the angle between the direction the sound travels and the direction the wind blows towards. Fully downwind within 45°, tapering to nothing at 90°; fully upwind beyond 135°, tapering to nothing at 90° from the other side.
- **Speed factor** `(v − 1) / 4`, clamped to 0–1: below 1 m/s the air is effectively still, by 5 m/s the effect has saturated.
- **Downwind gain**: nothing inside 100 m, +5 dB at 500 m, +7 dB at 1 km and beyond.
- **Upwind shadow**: opens at 600 m in a light breeze and at 300 m at 5 m/s, deepening over the next 400 m to between −10 and −15 dB.
- **Inversion**: 0 at 50 m rising to +5 dB at 300 m, in every direction. This is the old "still night" term, unchanged.

Inversion and downwind are combined with `max`, not a sum — both bend rays back to the ground by the same mechanism, and adding them would count it twice. The upwind shadow is added on top, halved when an inversion is working against it.

These are engineering approximations fitted to the numbers ISO 9613-2 and the ground-effect literature use, not a ray tracer. Treat them like the rest of the model: ±5 dB, useful for comparing sites and directions.

### Planned: climatology

The next step is a climatology mode: ten years of September nights for the actual site pulled from the Open-Meteo historical API, replacing "typical" with the median night and adding a 90th-percentile condition, so the envelope comes from that site's own weather rather than from three hand-picked presets.

## Terrain

A ridge between the stage and a house is usually the single biggest thing the flat model gets wrong, so Sound Reach reads the real ground and subtracts what it blocks. The code is in `src/terrain.ts` (pure, unit-tested in `src/terrain.test.ts`), the API client in `src/elevation.ts`, and the fetching and caching glue in `src/terrainService.ts`.

**Where the ground comes from.** Elevations come from terrain-RGB raster tiles: a 256×256 PNG in which every pixel encodes a height as `(R·256 + G + B/256) − 32768` metres. The source is [Tilezen terrain tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) hosted as AWS Open Data — free, no key, CORS-enabled, and a mosaic of national DEMs (EU-DEM over Europe, SRTM and GMTED2010 elsewhere). The app reads them at zoom 12, about 31 m per pixel at Sicilian latitudes, which is the native resolution of the data underneath.

Tiles are the reason this feature is usable rather than theoretical. One tile carries 65 536 elevations in a single ~90 kB request, so the whole zone grid is a handful of calls and everything afterwards — dragging a house, nudging the stage, adding a receptor — is a local array lookup with no network at all. Decoded tiles are kept in memory (48 of them, oldest dropped); the PNGs themselves are cached by the browser like any other tile.

The [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api) (Copernicus DEM GLO-90, 90 m) is kept on as a fallback for when the tile mosaic is unreachable. It answers one point per slot in a 100-point request, which is far too chatty to drag against, so it is only used after the tiles have failed. A failure sends every request to the fallback for two minutes, and no single fetch is ever split across the two sources, because mixing two DEMs inside one profile would put a fake step in the ground. After two minutes the next request tries the tiles again and switches back if they answer, so a momentary blip does not strand the session on the slow path. Either way, nothing but bare latitude/longitude pairs leaves the browser.

**How the drop is computed.** For each line of interest the app samples the geodesic from stage to receptor at 30 m (at most 100 samples, so one profile is one request) and reads the ground height at every sample. The stacks sit 2 m above the ground at the stage and the receiver 4 m above the ground at the house — a first-floor window, the worst case for a neighbour — and both heights are adjustable in the Adjust panel. The most obstructing sample is treated as a single knife edge: δ is the length of the diffracted path over that crest minus the straight line, in 3D. Maekawa's curve turns δ into an attenuation through the Fresnel number N = 2δ/λ:

```
A = 10·log10(3 + 20N)    for N ≥ −0.2,  capped at 20 dB
A = 0                    for a clear line of sight
```

The 20 dB ceiling is the ISO 9613-2 cap for a single edge. N = 0, where the crest just grazes the line of sight, already costs 4.8 dB.

**Why two numbers.** N scales with frequency, so the same ridge is evaluated twice: at 1 kHz for the A-weighted band and at 63 Hz for the bass band. A 12 m rise halfway along 600 m gives δ = 0.27 m, which is −15 dB(A) but only −7 dB of bass; a 30 m rise saturates the A-weighted cap at −20 dB and still lets −13 dB of bass through. That asymmetry is the point and matches what people report: the hill hides the music and leaves the thump.

**Receptors get it automatically.** Every house in the table is profiled as soon as it is placed, and again 300 ms after you stop dragging it. While a fetch is in flight the table shows the flat value with a `terrain…` tag; if the API cannot be reached it shows the flat value with `no terrain data` and says so on hover. The Terrain column gives the A-weighted drop, and clicking a row draws the elevation profile underneath: the ground, the direct line of sight, and the crest that does the blocking.

**Zones are opt-in.** The contours stay flat until you press **Apply terrain to zones**. That samples 36 bearings × 60 points (50 m steps out to 3 km) — about four tiles' worth of fetching — builds a shielding-vs-distance curve for each bearing, and interpolates between the two nearest bearings and the two nearest distances while the contour is traced. The contour is found by walking outwards in 50 m steps and bisecting the first step that crosses the threshold, rather than by bisecting the whole range: with a ridge in the way the level is no longer monotonic — it collapses behind the crest and recovers beyond it — and the first crossing is the honest one to draw. The result is cached against the stage position rounded to about 10 m; move the stage and the zones revert to flat until you press the button again. The legend says which of the two you are looking at. Beyond 3 km the last value on each bearing is held: once you are behind a hill you stay behind it.

### What terrain does not catch

- **~30 m resolution.** Each pixel averages roughly a 30 m cell (90 m on the Open-Meteo fallback), so garden walls, hedges, embankments, single buildings and narrow gullies are invisible. In a built-up village the real shielding is usually larger than the figure shown.
- **One edge only.** Two ridges in a row are treated as the worse of the two, not as two successive diffractions, which under-reads a deep valley.
- **No ground reflection, no vegetation, no meteorology in the diffraction.** Downwind refraction can bend sound back over a ridge that the geometry says is blocking; the model's generic night term does not know about the ridge.
- **No buildings.** The DEM is bare earth, so a house behind another house gets no credit for it.

Treat a terrain figure the same way as the rest of the model: a reason to look harder at one direction, not a number to put in an application.

## Project layout

```
index.html            page structure
src/main.ts           UI wiring and rendering
src/map.ts            Leaflet map, zones, markers, drag handles
src/acoustics.ts      propagation model (pure functions)
src/absorption.ts     ISO 9613-1 atmospheric absorption and the music spectrum
src/wind.ts           refraction by wind and temperature inversion
src/conditions.ts     the named weather conditions and their presets
src/terrain.ts        elevation profiles and Maekawa barrier attenuation (pure functions)
src/demTiles.ts       terrain-RGB tile client: tile maths, bilinear sampling, tile cache
src/png.ts            minimal PNG decoder, so tiles are read exactly and without a canvas
src/elevation.ts      Open-Meteo point API, the fallback elevation source
src/elevationSource.ts  the shared source interface and the tiering between the two
src/terrainService.ts fetch/cache/debounce glue between elevations and the model
src/zones.ts          zone definitions and contour tracing
src/geo.ts            lat/lon parsing, distance, bearing, destination
src/state.ts          scenario shape, defaults, localStorage, JSON import sanitising
src/style.css         tokens and layout (light/dark)
public/_headers       Cloudflare Pages headers
```

## Licence

MIT. Map data © OpenStreetMap contributors; imagery © Esri, Maxar, Earthstar Geographics, and the GIS user community (used under Esri's free tier terms; attribution is shown on the map).

Elevation data is attributed on the map and in full here, as the providers require:

- Europe terrain data produced using Copernicus data and information funded by the European Union — EU-DEM layers;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey;
- Global ETOPO1 terrain data, U.S. National Oceanic and Atmospheric Administration;
- Canada terrain data contains information licensed under the Open Government Licence — Canada;
- Austria terrain data © offene Daten Österreichs — Digitales Geländemodell (DGM) Österreich;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015, all rights reserved;
- Norway terrain data © Kartverket; Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017; New Zealand terrain data © 2011 Crown copyright, Land Information New Zealand; Mexico terrain data source INEGI, Continental relief, 2016; ArcticDEM DEMs created from DigitalGlobe, Inc. imagery and funded under NSF awards 1043681, 1559691 and 1542736.

The [full source list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) is maintained by the Tilezen project. Fallback elevation data from [Open-Meteo](https://open-meteo.com/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), derived from the Copernicus DEM GLO-90.
# sound-reach

# Sound Reach

A map tool for choosing a festival site: place the stage, set the volume as a percentage of what the rig can do, and see how far the sound carries and which houses fall in the red. Built for a 4× Funktion-One Evo 2 / 8× F121 system, adjustable to any rig.

Static site: Vite + TypeScript + Leaflet. No backend, no keys. Map tiles come from Esri World Imagery (satellite) and OpenStreetMap (streets); everything else runs in the browser. Scenarios are kept in `localStorage` and can be exported/imported as JSON.

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
- air absorption, 0.8 dB per 100 m for the A-weighted mix (dominated by 1–4 kHz), 0.05 dB per 100 m for the bass band;
- a ground term, −2 dB over soft ground beyond 200 m, phased in to 600 m;
- a favourable-propagation term, +5 dB beyond ~300 m when "still night / downwind / inversion" is on. This is the condition under which complaints arrive, so it is on by default.

Horizontal directivity: horn-loaded tops are modelled at 0 dB within ±30° of the aim, −6 dB at 90°, −12 dB behind. Subs are omnidirectional, or −10 dB behind when set to cardioid. Turning "directional" off gives a plain omnidirectional source.

Two bands are tracked. **dB(A)** is what every legal limit and derogation is measured in. The **bass band** (shown as dB(C), default 15 dB above the A-weighted figure for electronic music) is what neighbours notice at night; it is drawn as a dashed contour when enabled, because it carries for kilometres and otherwise swamps the map.

Zones can be read three ways:

- **Legal limit**: red where the predicted level at a façade is at or above the chosen night limit (Italian acoustic classes II–IV, the no-zoning transitional limit, or a derogation ceiling), amber within 5 dB of it, green 5–10 dB under.
- **Audibility**: loud / intrusive / clearly audible / faint, by level band.
- **dB rings**: plain contours at 90, 80, 70, 60, 50, 45 dB(A).

### What it does not model

Terrain, barriers, buildings, vegetation, reflections off water, humidity and temperature, and the actual Funktion-One polar response. A cliff or ridge between stage and village can take 10–20 dB off; a valley or a lake can carry sound further than predicted. Treat every number as ±5 dB and use the tool to compare sites and spot the houses that matter. A noise derogation application needs a *tecnico competente in acustica* with a proper forecast on the real terrain.

### Calibrating

Measure the rig once with an SPL meter (a phone app is fine for this purpose) at 10 m in front of the stacks at the volume you'd use, and type that figure into "Rig max" with the slider at 100%, or set the slider to the matching percentage. Everything else scales from it.

## Project layout

```
index.html            page structure
src/main.ts           UI wiring and rendering
src/map.ts            Leaflet map, zones, markers, drag handles
src/acoustics.ts      propagation model (pure functions)
src/zones.ts          zone definitions and contour tracing
src/geo.ts            lat/lon parsing, distance, bearing, destination
src/state.ts          scenario shape, defaults, localStorage, JSON import sanitising
src/style.css         tokens and layout (light/dark)
public/_headers       Cloudflare Pages headers
```

## Licence

MIT. Map data © OpenStreetMap contributors; imagery © Esri, Maxar, Earthstar Geographics, and the GIS user community (used under Esri's free tier terms; attribution is shown on the map).

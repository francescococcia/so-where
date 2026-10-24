// Bespoke "Portland stone" London basemap on OpenFreeMap vector tiles (OpenMapTiles schema, © OpenStreetMap contributors).
// No key, no Carto. Light stone land, white roads with soft casings, a pale Thames, light 3D buildings from z14.
import type { StyleSpecification } from "maplibre-gl";

export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>';

const C = {
  land: "#f5f3ee",
  land2: "#f0ede6",
  park: "#dcebd3",
  parkLine: "#cadfbe",
  water: "#c3dfe9",
  waterDeep: "#b2d5e2",
  waterLine: "#a2c8d6",
  minor: "#ffffff",
  minorCase: "#e4e0d7",
  mid: "#ffffff",
  midCase: "#d9d4c8",
  major: "#ffffff",
  majorCase: "#d2ccbf",
  motor: "#fff6dc",
  motorCase: "#e2cf9c",
  rail: "#b5b3ad",
  bldg: "#e7e4dd",
  bldgTop: "#f0eee9",
  label: "#55585f",
  labelHalo: "#f5f3ee",
};

const NAME: any = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]];
const W = (stops: [number, number][]): any => ["interpolate", ["exponential", 1.5], ["zoom"], ...stops.flat()];

export const SO_WHERE_STYLE: StyleSpecification = {
  version: 8,
  name: "So where? Portland stone (light)",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OSM_ATTRIBUTION },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": C.land } },
    { id: "residential", type: "fill", source: "omt", "source-layer": "landuse", filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]], paint: { "fill-color": C.land2, "fill-opacity": 0.7 } },
    { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": C.park } },
    { id: "landcover", type: "fill", source: "omt", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["grass", "wood", "farmland"]]], paint: { "fill-color": C.park, "fill-opacity": 0.8 } },
    { id: "landuse-green", type: "fill", source: "omt", "source-layer": "landuse", filter: ["in", ["get", "class"], ["literal", ["pitch", "cemetery", "stadium"]]], paint: { "fill-color": C.park, "fill-opacity": 0.6 } },
    { id: "park-line", type: "line", source: "omt", "source-layer": "park", minzoom: 12, paint: { "line-color": C.parkLine, "line-width": 1 } },
    // The Thames: deeper fill, an ink-blue bank line and a soft glow so it reads as the city's spine.
    { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
    { id: "water-bank", type: "line", source: "omt", "source-layer": "water", paint: { "line-color": C.waterLine, "line-width": W([[10, 0.6], [16, 1.6]]), "line-opacity": 0.75 } },
    { id: "river-glow", type: "line", source: "omt", "source-layer": "waterway", filter: ["==", ["get", "class"], "river"], paint: { "line-color": C.waterDeep, "line-width": W([[9, 2], [14, 10]]), "line-blur": 6, "line-opacity": 0.55 } },
    { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "line-color": C.water, "line-width": W([[11, 0.6], [16, 2.5]]) } },

    // Roads: casings, then fills. Everything white on light stone; hierarchy comes from width and casing.
    { id: "road-minor-case", type: "line", source: "omt", "source-layer": "transportation", minzoom: 13, filter: ["in", ["get", "class"], ["literal", ["minor", "service"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.minorCase, "line-width": W([[13, 1.5], [18, 16]]) } },
    { id: "road-mid-case", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11, filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.midCase, "line-width": W([[11, 1.2], [18, 22]]) } },
    { id: "road-major-case", type: "line", source: "omt", "source-layer": "transportation", filter: ["in", ["get", "class"], ["literal", ["primary", "trunk"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.majorCase, "line-width": W([[8, 1], [12, 2.6], [18, 16]]) } },
    { id: "road-motorway-case", type: "line", source: "omt", "source-layer": "transportation", filter: ["==", ["get", "class"], "motorway"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.motorCase, "line-width": W([[8, 1.4], [12, 3.2], [18, 18]]) } },
    { id: "path", type: "line", source: "omt", "source-layer": "transportation", minzoom: 15, filter: ["in", ["get", "class"], ["literal", ["path", "pedestrian"]]], paint: { "line-color": "#c9c5ba", "line-width": W([[15, 0.8], [18, 2]]), "line-dasharray": [2, 1.5] } },
    { id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 13, filter: ["in", ["get", "class"], ["literal", ["minor", "service"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.minor, "line-width": W([[13, 0.6], [18, 13]]) } },
    { id: "road-mid", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11, filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.mid, "line-width": W([[11, 0.6], [18, 18]]) } },
    { id: "road-major", type: "line", source: "omt", "source-layer": "transportation", filter: ["in", ["get", "class"], ["literal", ["primary", "trunk"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.major, "line-width": W([[8, 0.5], [12, 1.6], [18, 13]]) } },
    { id: "road-motorway", type: "line", source: "omt", "source-layer": "transportation", filter: ["==", ["get", "class"], "motorway"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.motor, "line-width": W([[8, 0.8], [12, 2], [18, 14]]) } },
    { id: "rail", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11, filter: ["all", ["in", ["get", "class"], ["literal", ["rail", "transit"]]], ["!=", ["get", "brunnel"], "tunnel"]], paint: { "line-color": C.rail, "line-width": W([[11, 0.6], [17, 2]]), "line-dasharray": [3, 2] } },

    // Buildings: flat footprints, then extruded Portland stone blocks.
    { id: "building-flat", type: "fill", source: "omt", "source-layer": "building", minzoom: 13, maxzoom: 14.5, paint: { "fill-color": C.bldg, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 0.9] } },
    {
      id: "building-3d",
      type: "fill-extrusion",
      source: "omt",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8], 0, C.bldg, 40, C.bldgTop, 120, "#f6f5f1"],
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["coalesce", ["get", "render_height"], 8]],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    },

    // Labels
    { id: "water-name", type: "symbol", source: "omt", "source-layer": "waterway", minzoom: 12, filter: ["==", ["get", "class"], "river"], layout: { "text-field": NAME, "text-font": ["Noto Sans Italic"], "symbol-placement": "line", "text-size": W([[12, 12], [16, 16]]), "text-letter-spacing": 0.25, "symbol-spacing": 400 }, paint: { "text-color": "#3f6f82", "text-halo-color": C.water, "text-halo-width": 1.2 } },
    { id: "road-name", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 14, filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk", "minor"]]], layout: { "text-field": NAME, "text-font": ["Noto Sans Regular"], "symbol-placement": "line", "text-size": W([[14, 10], [18, 13]]) }, paint: { "text-color": C.label, "text-halo-color": "#fff", "text-halo-width": 1.4 } },
    { id: "transit", type: "symbol", source: "omt", "source-layer": "poi", minzoom: 13, filter: ["in", ["get", "class"], ["literal", ["railway"]]], layout: { "text-field": NAME, "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-offset": [0, 0.9], "text-anchor": "top", "text-max-width": 8 }, paint: { "text-color": "#2e3138", "text-halo-color": "#fff", "text-halo-width": 1.5 } },
    { id: "transit-dot", type: "circle", source: "omt", "source-layer": "poi", minzoom: 13, filter: ["in", ["get", "class"], ["literal", ["railway"]]], paint: { "circle-radius": 3.5, "circle-color": "#fff", "circle-stroke-color": "#6b6e75", "circle-stroke-width": 1.4 } },
    { id: "place-minor", type: "symbol", source: "omt", "source-layer": "place", minzoom: 11, filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]], layout: { "text-field": ["upcase", NAME], "text-font": ["Noto Sans Bold"], "text-size": W([[11, 9.5], [15, 12]]), "text-letter-spacing": 0.14, "text-max-width": 7 }, paint: { "text-color": "#6b6e75", "text-halo-color": C.labelHalo, "text-halo-width": 1.6 } },
    { id: "place-city", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 12, filter: ["in", ["get", "class"], ["literal", ["city", "town"]]], layout: { "text-field": NAME, "text-font": ["Noto Sans Bold"], "text-size": 15 }, paint: { "text-color": C.label, "text-halo-color": C.labelHalo, "text-halo-width": 2 } },
  ],
};

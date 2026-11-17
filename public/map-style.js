/* Seconds map style: our own look on free OpenMapTiles vector data (OpenFreeMap, no key).
   Two palettes. Night: ink land, deep teal water, graphite roads with an ember main road.
   Day: warm paper, soft sage parks, white streets with sand-coloured main roads.
   Few labels and quiet colours, so food pins and spots are the brightest things on screen. */
window.secondsMapStyle = function (theme) {
  'use strict';
  const C = theme === 'light' ? {
    bg: '#f2eee6', town: '#ebe5da', green: '#dbe6cf', park: '#d3e3c3', water: '#b9d5e0', waterway: '#a9cbd9', building: '#e2dbcf', buildingLine: '#d6cdbf',
    path: '#e6dfd3', minor: '#ffffff', tertiary: '#ffffff', major: '#fdf3e2', trunk: '#f5c98f', rail: '#cfc7b9', boundary: '#bdb4a5',
    waterText: '#5f8ea2', roadText: '#8a8378', localText: '#8f877b', cityText: '#3b3832', countryText: '#7c766c', halo: '#f2eee6', waterHalo: '#b9d5e0'
  } : {
    bg: '#0d1013', town: '#11151a', green: '#111b16', park: '#122219', water: '#0a2230', waterway: '#0d2b3c', building: '#171c21', buildingLine: '#1f262d',
    path: '#262d34', minor: '#1f252b', tertiary: '#2a3138', major: '#363e46', trunk: '#5a4430', rail: '#2e333a', boundary: '#39414a',
    waterText: '#3f7590', roadText: '#6c7680', localText: '#66717c', cityText: '#c9d1d9', countryText: '#7d8893', halo: '#0d1013', waterHalo: '#0a2230'
  };
  const src = 'omt', name = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
  const cls = list => ['in', ['get', 'class'], ['literal', list]];
  const w = (a, b, c) => ['interpolate', ['exponential', 1.6], ['zoom'], a[0], a[1], b[0], b[1], c[0], c[1]];
  const road = (id, list, color, width, extra) => Object.assign({ id, type: 'line', source: src, 'source-layer': 'transportation', filter: cls(list), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: Object.assign({ 'line-color': color, 'line-width': width }, (extra && extra.paint) || {}) }, extra && extra.minzoom ? { minzoom: extra.minzoom } : {});
  return {
    version: 8,
    name: 'Seconds ' + (theme === 'light' ? 'day' : 'night'),
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { [src]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
      { id: 'landuse-town', type: 'fill', source: src, 'source-layer': 'landuse', filter: cls(['residential', 'suburb', 'neighbourhood', 'commercial', 'retail']), paint: { 'fill-color': C.town } },
      { id: 'landcover', type: 'fill', source: src, 'source-layer': 'landcover', filter: cls(['wood', 'grass', 'farmland', 'scrub']), paint: { 'fill-color': C.green, 'fill-opacity': 0.8 } },
      { id: 'park', type: 'fill', source: src, 'source-layer': 'park', paint: { 'fill-color': C.park, 'fill-opacity': 0.9 } },
      { id: 'water', type: 'fill', source: src, 'source-layer': 'water', paint: { 'fill-color': C.water } },
      { id: 'waterway', type: 'line', source: src, 'source-layer': 'waterway', paint: { 'line-color': C.waterway, 'line-width': w([8, 0.5], [13, 1.4], [18, 4]) } },
      { id: 'building', type: 'fill', source: src, 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1] } },
      road('road-path', ['path', 'pedestrian'], C.path, w([14, 0.5], [16, 1], [18, 2]), { minzoom: 14, paint: { 'line-dasharray': [1.5, 1.5] } }),
      road('road-minor', ['minor', 'service', 'track'], C.minor, w([12, 0.4], [15, 2], [18, 10]), { minzoom: 12 }),
      road('road-tertiary', ['tertiary'], C.tertiary, w([10, 0.4], [14, 2], [18, 13])),
      road('road-major', ['secondary', 'primary'], C.major, w([7, 0.4], [13, 2.4], [18, 18])),
      road('road-trunk', ['trunk', 'motorway'], C.trunk, w([5, 0.6], [12, 2.6], [18, 22])),
      road('rail', ['rail', 'transit'], C.rail, w([10, 0.5], [14, 1], [18, 2]), { paint: { 'line-dasharray': [3, 3] } }),
      { id: 'boundary', type: 'line', source: src, 'source-layer': 'boundary', filter: ['<=', ['get', 'admin_level'], 4], paint: { 'line-color': C.boundary, 'line-width': 1, 'line-dasharray': [3, 2] } },
      { id: 'water-name', type: 'symbol', source: src, 'source-layer': 'water_name', layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 12 }, paint: { 'text-color': C.waterText, 'text-halo-color': C.waterHalo, 'text-halo-width': 1 } },
      { id: 'road-name', type: 'symbol', source: src, 'source-layer': 'transportation_name', minzoom: 14, layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 13], 'text-max-angle': 30 }, paint: { 'text-color': C.roadText, 'text-halo-color': C.halo, 'text-halo-width': 1.4 } },
      { id: 'place-local', type: 'symbol', source: src, 'source-layer': 'place', minzoom: 11, filter: cls(['neighbourhood', 'suburb', 'quarter', 'village', 'hamlet']), layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 12], 'text-transform': 'uppercase', 'text-letter-spacing': 0.14, 'text-max-width': 8 }, paint: { 'text-color': C.localText, 'text-halo-color': C.halo, 'text-halo-width': 1.5 } },
      { id: 'place-city', type: 'symbol', source: src, 'source-layer': 'place', filter: cls(['city', 'town']), layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 17] }, paint: { 'text-color': C.cityText, 'text-halo-color': C.halo, 'text-halo-width': 1.6 } },
      { id: 'place-country', type: 'symbol', source: src, 'source-layer': 'place', maxzoom: 7, filter: cls(['country']), layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-transform': 'uppercase', 'text-letter-spacing': 0.2 }, paint: { 'text-color': C.countryText, 'text-halo-color': C.halo, 'text-halo-width': 1.5 } }
    ]
  };
};

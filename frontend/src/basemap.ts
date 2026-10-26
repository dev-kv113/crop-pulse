/**
 * Basemaps.
 *
 * All of them are declared in the style up front and switched by toggling layer
 * visibility. The obvious alternative -- `map.setStyle()` on each switch --
 * throws away every source and layer the app added, so the plot and its analysis
 * would vanish. Toggling visibility has no such problem and is instant.
 *
 * ---------------------------------------------------------------------------
 * `maxzoom` is not cosmetic
 *
 * It is the deepest level the provider really has tiles for. Past it, MapLibre
 * reuses the last real tile and scales it up ("overzoom"), so the view softens
 * but keeps working. Set it too deep and MapLibre requests tiles that do not
 * exist -- and Esri does not answer those with a 404, it answers with a grey
 * placeholder reading "Map data not yet available", which looks exactly like the
 * app breaking.
 *
 * Every value below was measured against the sample plots (77.29E, 30.33N,
 * rural Haryana) by fetching tiles and comparing them to the known placeholder:
 *
 *   Esri World Imagery ....... real through z18, placeholder from z19
 *   Esri World Street Map .... real through z17, placeholder from z18
 *   Esri World Topo Map ...... real through z17, placeholder from z18
 *   OpenStreetMap ............ tiles exist to z19 but are blank here; rural
 *                              Haryana has almost nothing mapped, so it was
 *                              dropped in favour of Esri's street cartography
 *
 * Coverage differs by region. If you deploy elsewhere, re-measure before
 * raising these, or set VITE_MAPTILER_KEY for deeper imagery everywhere.
 * ---------------------------------------------------------------------------
 */

import type { RasterSourceSpecification, StyleSpecification } from "maplibre-gl";

export interface BasemapOption {
  id: string;
  label: string;
  hint: string;
}

/**
 * Optional. Esri's free imagery stops at z18 in rural India -- about 0.5 m per
 * pixel, enough to see a plot but not rows within it. A free MapTiler key
 * raises that to z20. Nothing else in the app changes.
 */
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

const esriRaster = (
  service: string,
  maxzoom: number,
  attribution: string,
): RasterSourceSpecification => ({
  type: "raster",
  tiles: [`${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`],
  tileSize: 256,
  maxzoom,
  attribution,
});

const satellite: RasterSourceSpecification = MAPTILER_KEY
  ? {
      type: "raster",
      tiles: [
        `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`,
      ],
      tileSize: 256,
      maxzoom: 20,
      attribution: "&copy; MapTiler &copy; Esri and contributors",
    }
  : esriRaster(
      "World_Imagery",
      18,
      "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    );

export const BASEMAPS: BasemapOption[] = [
  {
    id: "satellite",
    label: "Satellite",
    hint: MAPTILER_KEY ? "Aerial imagery" : "Aerial imagery, sharpest around 50 m",
  },
  { id: "streets", label: "Streets", hint: "Roads and settlements" },
  { id: "topo", label: "Terrain", hint: "Contours and relief" },
];

export const DEFAULT_BASEMAP = "satellite";

/** Beyond this the basemap is only upscaling, so there is nothing to gain. */
export const MAX_MAP_ZOOM = 20;

export const MAP_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    satellite,
    streets: esriRaster("World_Street_Map", 17, "&copy; Esri"),
    topo: esriRaster("World_Topo_Map", 17, "&copy; Esri"),
  },
  layers: BASEMAPS.map((basemap) => ({
    id: `basemap-${basemap.id}`,
    type: "raster" as const,
    source: basemap.id,
    layout: {
      visibility:
        basemap.id === DEFAULT_BASEMAP ? ("visible" as const) : ("none" as const),
    },
  })),
};

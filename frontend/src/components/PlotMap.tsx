/**
 * The map.
 *
 * MapLibre owns its own DOM and is not a React component, so the pattern is:
 * build the map once, then push data into it from effects as props change.
 * Rebuilding it on every render would reset the view each time the farmer
 * touched a control.
 *
 * Layer order, bottom to top: basemap, analysis fill, analysis edges, plot
 * boundary. The boundary is drawn last because it is what the farmer orients
 * by, so it must never be covered by the analysis.
 */

import {
  GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre parses every GeoJSON source in a web worker. Version 6 finds that
// worker by computing a URL next to its own file at runtime, which the
// production build cannot see - so the worker was never emitted, and in a
// built app the plot boundary and survey layer silently never drew (the
// raster basemap needs no worker, so it looked like everything else worked).
// `?worker&url` has Vite bundle the worker, with the code it shares with the
// main library, and hand back its URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";

setWorkerUrl(maplibreWorkerUrl);

import { BASEMAPS, MAP_STYLE, MAX_MAP_ZOOM } from "../basemap";

const ANALYSIS_SOURCE = "plot-analysis";
const BOUNDARY_SOURCE = "plot-boundary";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Framing a small plot should not land past the imagery's real detail. */
const MAX_FIT_ZOOM = 18;

interface PlotMapProps {
  boundary: GeoJSON.FeatureCollection;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  analysis: GeoJSON.FeatureCollection | null;
  analysisOpacity: number;
  showBoundary: boolean;
  basemapId: string;
  /** Incremented by the parent's "zoom to plot" button. */
  recentreSignal: number;
}

export function PlotMap({
  boundary,
  bbox,
  analysis,
  analysisOpacity,
  showBoundary,
  basemapId,
  recentreSignal,
}: PlotMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  // Surfaced on screen rather than only in the console: a map that silently
  // renders nothing is the hardest kind of bug to report.
  const [failure, setFailure] = useState<string | null>(null);

  // --- build the map once --------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new MapLibreMap({
      container: container.current,
      style: MAP_STYLE,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      zoom: 15,
      // Past this the basemap is only upscaling what it already showed, so
      // allowing more zoom just invites the provider's "no data" tiles.
      maxZoom: MAX_MAP_ZOOM,
      attributionControl: { compact: true },
    });
    map.current = instance;

    // No compass: the map is north-locked and never pitched, so it would be a
    // control that never does anything.
    instance.addControl(
      new NavigationControl({ showCompass: false, visualizePitch: false }),
      "top-right",
    );
    instance.addControl(new ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-left");

    instance.on("error", (event) => {
      // Tile 404s are noisy and harmless; a missing style or source is not.
      const message = event.error?.message ?? "Map error";
      if (!/tile|abort|Failed to fetch/i.test(message)) setFailure(message);
      console.warn("[map]", message);
    });

    const build = () => {
      try {
        instance.addSource(ANALYSIS_SOURCE, { type: "geojson", data: EMPTY });
        instance.addSource(BOUNDARY_SOURCE, { type: "geojson", data: EMPTY });

        // Each feature carries its own colour from the API, so the map and the
        // legend are driven by one source of truth and cannot disagree.
        instance.addLayer({
          id: "analysis-fill",
          type: "fill",
          source: ANALYSIS_SOURCE,
          paint: {
            "fill-color": ["to-color", ["get", "color"]],
            "fill-opacity": analysisOpacity,
          },
        });

        instance.addLayer({
          id: "analysis-edge",
          type: "line",
          source: ANALYSIS_SOURCE,
          paint: { "line-color": "rgba(0,0,0,0.30)", "line-width": 0.5 },
        });

        // White casing under a dark core, so the boundary stays visible over
        // both bright soil and dark canopy.
        instance.addLayer({
          id: "boundary-casing",
          type: "line",
          source: BOUNDARY_SOURCE,
          paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.9 },
        });
        instance.addLayer({
          id: "boundary-line",
          type: "line",
          source: BOUNDARY_SOURCE,
          paint: { "line-color": "#16124e", "line-width": 2 },
        });

        setReady(true);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    };

    // `load` has already fired if the style was cached, in which case the event
    // never arrives and the map would stay empty forever.
    if (instance.isStyleLoaded()) build();
    else instance.once("load", build);

    // Click a class to read what it is.
    const popup = new Popup({ closeButton: true, maxWidth: "240px" });
    instance.on("click", "analysis-fill", (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const p = feature.properties ?? {};
      popup
        .setLngLat(event.lngLat)
        .setHTML(
          `<div class="map-popup">
             <span class="map-popup-swatch" style="background:${p.color}"></span>
             <strong>${p.label ?? "Class"}</strong>
             ${p.detail ? `<span class="map-popup-detail">Density ${p.detail}</span>` : ""}
             <span class="map-popup-area">${Number(p.area_ha ?? 0).toFixed(3)} ha</span>
           </div>`,
        )
        .addTo(instance);
    });
    instance.on("mouseenter", "analysis-fill", () => {
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", "analysis-fill", () => {
      instance.getCanvas().style.cursor = "";
    });

    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
    // Built once on purpose; every prop below is applied by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- boundary, and framing the plot --------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    (instance.getSource(BOUNDARY_SOURCE) as GeoJSONSource | undefined)?.setData(boundary);
    instance.fitBounds(bbox, { padding: 56, maxZoom: MAX_FIT_ZOOM, duration: 0 });
  }, [ready, boundary, bbox]);

  // --- analysis ------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    (instance.getSource(ANALYSIS_SOURCE) as GeoJSONSource | undefined)?.setData(
      analysis ?? EMPTY,
    );
  }, [ready, analysis]);

  // --- opacity -------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    instance.setPaintProperty("analysis-fill", "fill-opacity", analysisOpacity);
    instance.setPaintProperty("analysis-edge", "line-opacity", analysisOpacity > 0.2 ? 1 : 0);
  }, [ready, analysisOpacity]);

  // --- boundary visibility -------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const visibility = showBoundary ? "visible" : "none";
    instance.setLayoutProperty("boundary-casing", "visibility", visibility);
    instance.setLayoutProperty("boundary-line", "visibility", visibility);
  }, [ready, showBoundary]);

  // --- basemap -------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    for (const basemap of BASEMAPS) {
      instance.setLayoutProperty(
        `basemap-${basemap.id}`,
        "visibility",
        basemap.id === basemapId ? "visible" : "none",
      );
    }
  }, [ready, basemapId]);

  // --- zoom to plot --------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || recentreSignal === 0) return;
    instance.fitBounds(bbox, { padding: 56, maxZoom: MAX_FIT_ZOOM, duration: 600 });
  }, [ready, recentreSignal, bbox]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {failure && (
        <div className="map-failure" role="alert">
          Map failed to load: {failure}
        </div>
      )}
    </div>
  );
}

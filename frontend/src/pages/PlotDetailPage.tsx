/**
 * The map screen, and the whole of the farmer's app.
 *
 * An admin reaches the same screen when previewing a farmer's view. It is
 * deliberately the same component and the same API calls: a preview built from
 * a separate code path would eventually stop matching what farmers see.
 */

import { Suspense, lazy, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import { useAuth } from "../auth";
import { BASEMAPS, DEFAULT_BASEMAP } from "../basemap";
import { AppHeader } from "../components/AppHeader";
import { LayerControl } from "../components/LayerControl";
import type {
  LayerSummary,
  PlotAnalysis,
  PlotDetail,
  PlotSummary,
} from "../types";

// MapLibre is by far the largest dependency. Loading it only when a plot is
// opened keeps the login screen small, which matters on a rural mobile
// connection.
const PlotMap = lazy(() =>
  import("../components/PlotMap").then((module) => ({ default: module.PlotMap })),
);

export function PlotDetailPage() {
  const { plotId } = useParams();
  const id = Number(plotId);
  const navigate = useNavigate();
  const { role, farmer, signOut } = useAuth();
  const isAdmin = role === "admin";
  const isUnitHead = role === "unit_head";
  // Admins and unit heads are looking at somebody else's land.
  const isPreview = isAdmin || isUnitHead;

  const [plot, setPlot] = useState<PlotDetail | null>(null);
  const [myPlots, setMyPlots] = useState<PlotSummary[]>([]);
  const [layers, setLayers] = useState<LayerSummary[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<PlotAnalysis | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP);
  const [showBoundary, setShowBoundary] = useState(true);
  const [opacity, setOpacity] = useState(0.8);
  const [recentreSignal, setRecentreSignal] = useState(0);

  const [error, setError] = useState<string | null>(null);

  // A farmer's own plots, for the switcher. Admins preview one plot at a time
  // and pick the next from the admin screen, so they do not need this.
  useEffect(() => {
    if (isPreview) return;
    api
      .myPlots()
      .then(setMyPlots)
      .catch(() => setMyPlots([]));
  }, [isPreview]);

  useEffect(() => {
    setPlot(null);
    setAnalysis(null);
    setActiveLayerId(null);
    Promise.all([api.plot(id), api.plotLayers(id)])
      .then(([detail, available]) => {
        setPlot(detail);
        setLayers(available);
        // Open on the most recent survey. That is what the farmer came to see,
        // and a bare boundary looks like nothing loaded.
        if (available.length > 0) setActiveLayerId(available[0].id);
      })
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    if (activeLayerId === null) {
      setAnalysis(null);
      return;
    }
    setLoadingAnalysis(true);
    let cancelled = false;
    api
      .plotAnalysis(id, activeLayerId)
      .then((result) => !cancelled && setAnalysis(result))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoadingAnalysis(false));
    // Tapping quickly through dates must not let an earlier response overwrite
    // a later one.
    return () => {
      cancelled = true;
    };
  }, [id, activeLayerId]);

  if (error) return <p className="error page-pad">{error}</p>;
  if (!plot) return <p className="hint page-pad">Loading plot…</p>;

  return (
    <div className="plot-page">
      <AppHeader
        title={plot.village ?? `Plot ${plot.uniq_id}`}
        subtitle={[
          plot.unit_name,
          plot.variety ?? "Variety not recorded",
          plot.mapped_area_acres
            ? `${plot.mapped_area_acres.toFixed(2)} acres`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          isPreview ? (
            <Link
              className="button button-quiet button-small"
              to={isAdmin ? "/admin" : "/unit"}
            >
              Back
            </Link>
          ) : (farmer?.plot_count ?? 0) > 1 ? (
            <Link className="button button-quiet button-small" to="/plots">
              All plots
            </Link>
          ) : (
            <button className="button button-quiet button-small" onClick={signOut}>
              Sign out
            </button>
          )
        }
      />

      {/* An admin looking at someone else's land should never be in doubt that
          this is a preview. */}
      {isPreview && (
        <div className="preview-bar">
          Previewing as <strong>{plot.farmer_name ?? "farmer"}</strong>
          {plot.farm_code && <span className="preview-code">{plot.farm_code}</span>}
          <span className="preview-note">
            Exactly what they see when they sign in.
          </span>
        </div>
      )}

      <div className="plot-body">
        <div className="map-column">
          <Suspense fallback={<div className="map map-loading">Loading map…</div>}>
            <PlotMap
              boundary={plot.boundary}
              bbox={plot.bbox}
              analysis={analysis?.geojson ?? null}
              analysisOpacity={opacity}
              showBoundary={showBoundary}
              basemapId={basemapId}
              recentreSignal={recentreSignal}
            />
          </Suspense>
          <button
            className="map-tool"
            title="Zoom to plot"
            onClick={() => setRecentreSignal((n) => n + 1)}
          >
            ⌖ Zoom to plot
          </button>
        </div>

        <LayerControl
          plot={plot}
          myPlots={isPreview ? [] : myPlots}
          onSelectPlot={(nextId) => navigate(`/plots/${nextId}`)}
          basemaps={BASEMAPS}
          basemapId={basemapId}
          onBasemapChange={setBasemapId}
          showBoundary={showBoundary}
          onShowBoundaryChange={setShowBoundary}
          layers={layers}
          activeLayerId={activeLayerId}
          onSelectLayer={setActiveLayerId}
          opacity={opacity}
          onOpacityChange={setOpacity}
          breakdown={analysis?.breakdown ?? []}
          coveredAreaHa={analysis?.covered_area_ha ?? 0}
          loading={loadingAnalysis}
        />
      </div>
    </div>
  );
}

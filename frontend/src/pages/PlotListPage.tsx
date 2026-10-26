/**
 * A farmer's plots, when they hold more than one.
 *
 * Farmers with a single plot never see this — they go straight to the map,
 * because a one-item list is friction for nothing. Farmers with several get to
 * choose, and can still switch between them from inside the map screen.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import { useAuth } from "../auth";
import { AppHeader } from "../components/AppHeader";
import type { PlotSummary } from "../types";

export function PlotListPage() {
  const { farmer, signOut } = useAuth();
  const [plots, setPlots] = useState<PlotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .myPlots()
      .then(setPlots)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error page-pad">{error}</p>;
  if (!plots) return <p className="hint page-pad">Loading your plots…</p>;

  const totalAcres = plots.reduce(
    (sum, plot) => sum + (plot.mapped_area_acres ?? 0),
    0,
  );

  return (
    <main className="list-page">
      <AppHeader
        title={farmer?.name ?? "My plots"}
        subtitle={`${plots.length} plots · ${totalAcres.toFixed(2)} acres`}
        actions={
          <button className="button button-quiet button-small" onClick={signOut}>
            Sign out
          </button>
        }
      />

      <ul className="plot-list">
        {plots.map((plot) => (
          <li key={plot.id}>
            <Link className="plot-card" to={`/plots/${plot.id}`}>
              <span className="plot-card-name">
                {plot.village ?? `Plot ${plot.uniq_id}`}
              </span>
              <span className="plot-card-meta">
                {plot.variety ?? "Variety not recorded"}
                {plot.mapped_area_acres
                  ? ` · ${plot.mapped_area_acres.toFixed(2)} acres`
                  : ""}
              </span>
              <span className="plot-card-id">
                Plot {plot.uniq_id}
                {plot.unit_name ? ` · ${plot.unit_name}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

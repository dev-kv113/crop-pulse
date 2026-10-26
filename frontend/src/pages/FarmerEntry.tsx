/**
 * Where a farmer lands after signing in.
 *
 * One plot: straight to the map, because a one-item list is friction for
 * nothing. Several plots: the list, so they can choose. Either way the map
 * screen also carries a switcher, so they never have to come back here.
 */

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { api } from "../api";
import { useAuth } from "../auth";
import { PlotListPage } from "./PlotListPage";
import type { PlotSummary } from "../types";

export function FarmerEntry() {
  const { signOut } = useAuth();
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

  if (plots.length === 0) {
    return (
      <main className="page-pad">
        <p className="hint">
          No plots are linked to your number yet. Please contact your field
          officer.
        </p>
        <button className="button button-quiet" onClick={signOut}>
          Sign out
        </button>
      </main>
    );
  }

  if (plots.length === 1) return <Navigate to={`/plots/${plots[0].id}`} replace />;

  // PlotListPage fetches the list again rather than taking it as a prop. That
  // is one extra request on a screen that is opened rarely, and it keeps the
  // page usable on its own from the /plots route.
  return <PlotListPage />;
}

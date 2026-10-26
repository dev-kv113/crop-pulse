/**
 * The unit screen, shared by a unit head and a read-only admin.
 *
 * Two things per unit: find a farmer and open that farmer's screen, and read
 * that unit's crop monitoring dashboard. Neither role can upload, rename or
 * grant anything — everything here is a read.
 *
 * The only difference between the two is how many units they may open, and that
 * comes from the API rather than from a flag passed in here: `/api/unit/list`
 * returns one unit for a unit head and all of them for a read-only admin, so
 * the picker appears only when there is something to pick. One screen for both
 * roles means a read-only admin sees exactly what the unit head sees, which is
 * the point of the role.
 *
 * They are two views rather than one long page. Stacked, the farmer table is
 * fifty rows tall and the dashboard sits below all of it, which on a phone is a
 * lot of scrolling to reach the thing you opened the app for. Neither is
 * subordinate to the other, so neither goes second.
 */

import { useCallback, useEffect, useState } from "react";

import { analyticsUrl } from "../analytics";
import { api } from "../api";
import { useAuth } from "../auth";
import { AppHeader } from "../components/AppHeader";
import { FarmerTable } from "../components/FarmerTable";
import type { UnitOption, UnitSummary } from "../types";

type View = "farmers" | "monitoring";

const VIEWS: { id: View; label: string }[] = [
  { id: "farmers", label: "Farmers" },
  { id: "monitoring", label: "Crop monitoring" },
];

export function UnitHomePage() {
  const { unit, signOut } = useAuth();
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [summary, setSummary] = useState<UnitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("farmers");

  /*
   * The dashboard is a whole second app fetched over the network, so it is not
   * mounted until somebody asks for it — a unit head who only ever looks up
   * farmers never pays for it. Once mounted it stays mounted, hidden rather
   * than unmounted, so switching back does not restart its session and lose
   * wherever they had got to. The farmer table is kept for the same reason:
   * a search and its page survive a trip to the dashboard.
   */
  const [monitoringOpened, setMonitoringOpened] = useState(false);

  useEffect(() => {
    api
      .unitList()
      .then((list) => {
        setUnits(list);
        setUnitId(list[0]?.id ?? null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (unitId === null) return;
    // Clear first: showing the previous unit's totals under the new unit's name
    // for the length of a request is worse than showing nothing.
    setSummary(null);
    api
      .unitSummary(unitId)
      .then(setSummary)
      .catch((err) => setError(err.message));
  }, [unitId]);

  // Identity changes with the unit, which is what makes the farmer table
  // reload rather than keep showing the unit you just left.
  const fetchPage = useCallback(
    (search: string, offset: number, limit: number) =>
      api.unitPlots(search, offset, limit, unitId ?? undefined),
    [unitId],
  );

  const show = (next: View) => {
    if (next === "monitoring") setMonitoringOpened(true);
    setView(next);
  };

  return (
    <main className="unit-page">
      <AppHeader
        title={summary?.name ?? unit?.name ?? "My unit"}
        subtitle={
          summary
            ? `${summary.farmer_count.toLocaleString("en-IN")} farmers · ${summary.plot_count.toLocaleString("en-IN")} plots`
            : undefined
        }
        actions={
          <button className="button button-quiet button-small" onClick={signOut}>
            Sign out
          </button>
        }
      />

      <div className="admin-body">
        {error && <p className="error card-wide">{error}</p>}

        {/* Only when there is a choice: a unit head gets a one-unit list and
            no picker, which is the same screen with nothing to decide. */}
        {units.length > 1 && (
          <section className="card card-wide">
            <h2>Unit</h2>
            <p className="hint">
              Everything below is that unit's — its farmers, and its monitoring
              dashboard.
            </p>
            <div className="unit-grid">
              {units.map((u) => (
                <button
                  key={u.id}
                  className={`unit-chip ${u.id === unitId ? "is-on" : ""}`}
                  onClick={() => setUnitId(u.id)}
                >
                  <span className="unit-chip-name">{u.name}</span>
                  <span className="unit-chip-meta">
                    {u.farmer_count.toLocaleString("en-IN")} farmers ·{" "}
                    {u.plot_count.toLocaleString("en-IN")} plots
                  </span>
                  <span className="unit-chip-meta">
                    {u.analytics_code
                      ? `${u.analytics_code} dashboard`
                      : "no dashboard"}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Sticky, so it is still one tap away fifty rows into the farmer
            table rather than a scroll back to the top. */}
        <div className="view-switcher card-wide">
          <div className="tabs" role="tablist" aria-label="Unit views">
            {VIEWS.map(({ id, label }, index) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={view === id}
                aria-controls={`panel-${id}`}
                /* Roving tabindex: a tablist is one stop in the tab order, and
                   the arrow keys move within it. */
                tabIndex={view === id ? 0 : -1}
                className={`tab ${view === id ? "is-on" : ""}`}
                onClick={() => show(id)}
                onKeyDown={(event) => {
                  const step =
                    event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next =
                    VIEWS[(index + step + VIEWS.length) % VIEWS.length];
                  show(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div
          className="unit-panel"
          id="panel-farmers"
          role="tabpanel"
          aria-labelledby="tab-farmers"
          hidden={view !== "farmers"}
        >
          {summary && (
            <section className="stat-row">
              <Stat label="Farmers" value={summary.farmer_count} />
              <Stat label="With a login" value={summary.farmers_with_login} />
              <Stat label="Plots" value={summary.plot_count} />
              <Stat label="Survey dates" value={summary.layer_count} />
            </section>
          )}

          {summary && summary.farmers_with_login < summary.farmer_count && (
            <p className="hint">
              {(
                summary.farmer_count - summary.farmers_with_login
              ).toLocaleString("en-IN")}{" "}
              farmers in this unit have no mobile number on file yet, so they
              cannot sign in. An administrator can add these.
            </p>
          )}

          <section className="card">
            <h2>Farmers in {summary?.name ?? unit?.name ?? "this unit"}</h2>
            <p className="hint">
              Open any farmer's plot exactly as they see it — the same map,
              survey dates and categories.
            </p>
            <FarmerTable
              fetchPage={fetchPage}
              emptyHint="No farmers in this unit matched that search."
            />
          </section>
        </div>

        <div
          className="unit-panel"
          id="panel-monitoring"
          role="tabpanel"
          aria-labelledby="tab-monitoring"
          hidden={view !== "monitoring"}
        >
          {/* Keyed by unit: switching unit must give the frame a fresh load
              rather than leave the previous mill's dashboard on screen. */}
          {summary && monitoringOpened && (
            <MonitoringView key={summary.id} summary={summary} />
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * The unit's crop monitoring dashboard, framed.
 *
 * It is a separate app on its own domain, so this is an iframe rather than a
 * rebuild of it here — the dashboard changes on its own schedule and there is
 * nothing to keep in step. The frame is not a cut-down copy: the dashboard's own
 * sidebar toggle opens its filters in place, so nothing here needs a full tab to
 * be usable. The link out stays anyway, because the dashboard is dense and built
 * for a laptop and on a phone a full tab beats any frame we can give it — an
 * escape hatch, not a prerequisite. Everything above the frame is kept to one
 * row and one line for the same reason, so the frame gets the screen.
 *
 * A unit with no code shows a plain note instead. Falling back to some default
 * mill would quietly show a unit head another unit's crop condition, which is
 * worse than showing nothing.
 */
function MonitoringView({ summary }: { summary: UnitSummary }) {
  const framed = analyticsUrl(summary.analytics_code, { embed: true });
  const full = analyticsUrl(summary.analytics_code);

  if (!framed || !full) {
    return (
      <section className="card">
        <h2>Crop monitoring</h2>
        <p className="hint">
          This unit is not linked to a monitoring dashboard yet. An
          administrator can point it at one from the Unit section of the admin
          screen.
        </p>
      </section>
    );
  }

  return (
    <section className="card monitoring-card">
      <div className="monitoring-head">
        <h2>Crop monitoring — {summary.name}</h2>
        <a
          className="button button-quiet button-small"
          href={full}
          target="_blank"
          rel="noreferrer"
        >
          Open full ↗
        </a>
      </div>
      <p className="hint">
        The whole unit this season. Use the » control inside the dashboard for
        filters.
      </p>
      <div className="analytics-frame">
        <iframe
          src={framed}
          title={`Crop monitoring dashboard for ${summary.name}`}
          /* The dashboard is a trusted first-party app, but it is still a
             different origin, so it gets what it needs and nothing more —
             notably not the ability to navigate this page out from under the
             unit head. `allow-same-origin` is not optional: without it the
             frame is given an opaque origin, its own storage is denied and
             Streamlit cannot hold a session at all. If the frame ever comes up
             blank after a dashboard upgrade, drop this attribute first — it is
             the only thing here that constrains that app. */
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value.toLocaleString("en-IN")}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

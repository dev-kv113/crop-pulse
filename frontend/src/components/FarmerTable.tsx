/**
 * Search farmers and open any of their plots as they see it.
 *
 * Used by both the admin screen and the unit-head screen. They differ only in
 * whether the phone number can be edited, so one component keeps the two views
 * in step and means a fix to one is a fix to both.
 *
 * Results are paged: the register runs to tens of thousands of plots, so the
 * table shows one page and says how many matched in total. Loading all of them
 * would be a slow response and an unreadable table.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { AdminPlot, PlotSearchPage } from "../types";

const PAGE_SIZE = 50;

interface FarmerTableProps {
  /** Fetches one page. Supplied by the caller so each role uses its own route. */
  fetchPage: (search: string, offset: number, limit: number) => Promise<PlotSearchPage>;
  /** Rendered in the Mobile column. Omit for a read-only table. */
  renderPhone?: (plot: AdminPlot) => React.ReactNode;
  emptyHint?: string;
}

export function FarmerTable({
  fetchPage,
  renderPhone,
  emptyHint = "No farmers matched that search.",
}: FarmerTableProps) {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AdminPlot[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (term: string, offset: number) => {
      setBusy(true);
      setError(null);
      try {
        const page = await fetchPage(term, offset, PAGE_SIZE);
        // Appending on "load more", replacing on a new search.
        setRows((current) =>
          offset === 0 ? page.results : [...(current ?? []), ...page.results],
        );
        setTotal(page.total);
        setHasMore(page.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load farmers");
      } finally {
        setBusy(false);
      }
    },
    [fetchPage],
  );

  // Show the first page as soon as the screen opens, rather than an empty box.
  useEffect(() => {
    void load("", 0);
  }, [load]);

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load(search, 0);
        }}
      >
        <label className="field">
          <span>Search by farmer, farm code, village or plot ID</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="e.g. JAIPAL, K01072, MACHHRAULI or 1320174"
          />
        </label>
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {rows && rows.length === 0 && <p className="hint">{emptyHint}</p>}

      {rows && rows.length > 0 && (
        <>
          <p className="result-count">
            Showing <strong>{rows.length.toLocaleString("en-IN")}</strong> of{" "}
            <strong>{total.toLocaleString("en-IN")}</strong> plots
          </p>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Farmer</th>
                  <th>Village</th>
                  <th>Plot ID</th>
                  <th className="num">Area</th>
                  <th className="num">Dates</th>
                  <th>Mobile</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((plot) => (
                  <tr key={plot.id}>
                    <td data-label="Farmer">
                      <span>
                        {plot.farmer_name ?? "—"}
                        <span className="cell-sub">{plot.farm_code}</span>
                      </span>
                    </td>
                    <td data-label="Village">{plot.village ?? "—"}</td>
                    <td data-label="Plot ID">{plot.uniq_id}</td>
                    <td className="num" data-label="Area">
                      {plot.computed_area_ha
                        ? `${(plot.computed_area_ha * 2.471054).toFixed(2)} ac`
                        : "—"}
                    </td>
                    <td className="num" data-label="Dates">
                      {plot.layer_count}
                    </td>
                    <td data-label="Mobile">
                      {renderPhone ? (
                        renderPhone(plot)
                      ) : plot.phone ? (
                        plot.phone
                      ) : (
                        <span className="cell-warn">no login yet</span>
                      )}
                    </td>
                    <td className="row-actions" data-label="">
                      <Link
                        className="button button-quiet button-small"
                        to={`/plots/${plot.id}`}
                      >
                        View as farmer
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <button
              className="button button-quiet load-more"
              onClick={() => void load(search, rows.length)}
              disabled={busy}
            >
              {busy ? "Loading…" : `Load ${PAGE_SIZE} more`}
            </button>
          )}
        </>
      )}
    </>
  );
}

/**
 * The layer control, laid out the way GIS tools conventionally do it:
 *
 *   Basemap        - mutually exclusive, so radio behaviour
 *   Overlays       - independently toggled, so checkbox behaviour
 *   Survey layer   - one at a time (they are the same measurement on different
 *                    dates, and stacking them would be meaningless), so radio
 *   Opacity        - applies to the active survey layer
 *   Legend         - what the colours mean, plus how much of the plot each covers
 *
 * Keeping these groups visually distinct is what makes a map feel like a map
 * rather than a page with an image on it.
 */

import type { BasemapOption } from "../basemap";
import type {
  ClassBreakdown,
  LayerSummary,
  PlotDetail,
  PlotSummary,
} from "../types";

interface LayerControlProps {
  plot: PlotDetail;
  /** The farmer's other plots. Empty for an admin preview. */
  myPlots: PlotSummary[];
  onSelectPlot: (plotId: number) => void;
  basemaps: BasemapOption[];
  basemapId: string;
  onBasemapChange: (id: string) => void;

  showBoundary: boolean;
  onShowBoundaryChange: (value: boolean) => void;


  layers: LayerSummary[];
  activeLayerId: number | null;
  onSelectLayer: (id: number | null) => void;

  opacity: number;
  onOpacityChange: (value: number) => void;

  breakdown: ClassBreakdown[];
  coveredAreaHa: number;
  loading: boolean;
}

export function LayerControl(props: LayerControlProps) {
  const active = props.layers.find((l) => l.id === props.activeLayerId) ?? null;

  return (
    <aside className="control">
      <div className="control-grip" aria-hidden="true" />

      <Section title="Plot">
        {/* Only when there is a choice to make. Most farmers hold one plot and
            should not be shown a control that does nothing. */}
        {props.myPlots.length > 1 && (
          <label className="field plot-switch">
            <span>Showing</span>
            <select
              value={props.plot.id}
              onChange={(e) => props.onSelectPlot(Number(e.target.value))}
            >
              {props.myPlots.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.village ?? "Plot"} · {p.uniq_id}
                  {p.mapped_area_acres
                    ? ` · ${p.mapped_area_acres.toFixed(2)} ac`
                    : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Two areas, named so neither is a mystery number: one is what the
            mill recorded at survey time, the other is measured from the
            boundary's own coordinates. */}
        <dl className="facts">
          <dt>Mapped area</dt>
          <dd>
            {props.plot.mapped_area_acres?.toFixed(2) ?? "—"} acres
            <span className="facts-alt">
              {props.plot.mapped_area_ha?.toFixed(3) ?? "—"} ha
            </span>
          </dd>

          <dt>Surveyed area</dt>
          <dd>
            {props.plot.survey_area_acres?.toFixed(2) ?? "—"} acres
            <span className="facts-alt">as recorded by the mill</span>
          </dd>

          <dt>Variety</dt>
          <dd>{props.plot.variety ?? "Not recorded"}</dd>

          <dt>Unit</dt>
          <dd>{props.plot.unit_name ?? "—"}</dd>

          <dt>Plot ID</dt>
          <dd>{props.plot.uniq_id}</dd>
        </dl>
      </Section>

      <Section title="Basemap">
        <div className="segmented" role="radiogroup" aria-label="Basemap">
          {props.basemaps.map((basemap) => (
            <button
              key={basemap.id}
              role="radio"
              aria-checked={props.basemapId === basemap.id}
              title={basemap.hint}
              className={`segment ${props.basemapId === basemap.id ? "is-on" : ""}`}
              onClick={() => props.onBasemapChange(basemap.id)}
            >
              {basemap.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Overlays">
        <label className="check">
          <input
            type="checkbox"
            checked={props.showBoundary}
            onChange={(e) => props.onShowBoundaryChange(e.target.checked)}
          />
          <span className="check-swatch check-swatch-outline" aria-hidden="true" />
          <span>Plot boundary</span>
        </label>
      </Section>

      <Section title="Survey layer">
        {props.layers.length === 0 ? (
          <p className="hint">
            No survey has been published for this plot yet.
          </p>
        ) : (
          <div className="radio-list" role="radiogroup" aria-label="Survey layer">
            <label className="check">
              <input
                type="radio"
                name="survey-layer"
                checked={props.activeLayerId === null}
                onChange={() => props.onSelectLayer(null)}
              />
              <span>None</span>
            </label>
            {props.layers.map((layer) => (
              <label key={layer.id} className="check">
                <input
                  type="radio"
                  name="survey-layer"
                  checked={props.activeLayerId === layer.id}
                  onChange={() => props.onSelectLayer(layer.id)}
                />
                <span>
                  {formatDate(layer.capture_date)}
                  <span className="check-sub">{layer.name}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Section>

      {active && (
        <>
          <Section title="Opacity">
            <div className="slider-row">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(props.opacity * 100)}
                onChange={(e) => props.onOpacityChange(Number(e.target.value) / 100)}
                aria-label="Survey layer opacity"
              />
              <span className="slider-value">{Math.round(props.opacity * 100)}%</span>
            </div>
          </Section>

          <Section
            title="Legend"
            note={
              props.loading ? undefined : `${props.coveredAreaHa.toFixed(2)} ha analysed`
            }
          >
            {/* The full classification, so the scale is legible even when a
                small plot only spans a few of its bands. */}
            <div className="ramp" aria-hidden="true">
              {active.classes.map((cls) => (
                <span
                  key={cls.class_id}
                  className="ramp-step"
                  style={{ background: cls.color }}
                  title={`${cls.label} (${cls.detail ?? ""})`}
                />
              ))}
            </div>
            <div className="ramp-ends">
              <span>Sparse canopy</span>
              <span>Dense canopy</span>
            </div>

            {props.loading ? (
              <p className="hint">Loading…</p>
            ) : (
              <ul className="legend">
                {props.breakdown.map((row) => (
                  <li key={row.class_id} className="legend-row">
                    <span
                      className="legend-swatch"
                      style={{ background: row.color }}
                      aria-hidden="true"
                    />
                    <span className="legend-label">
                      {row.label}
                      {row.detail && <span className="legend-detail">{row.detail}</span>}
                    </span>
                    <span className="legend-bar" aria-hidden="true">
                      <span
                        className="legend-bar-fill"
                        style={{ width: `${row.percent}%`, background: row.color }}
                      />
                    </span>
                    <span className="legend-percent">{row.percent.toFixed(1)}%</span>
                    <span className="legend-area">{row.area_ha.toFixed(2)} ha</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </aside>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="control-section">
      <h2 className="control-title">
        {title}
        {note && <span className="control-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

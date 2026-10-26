/**
 * The link to the crop monitoring dashboard.
 *
 * That dashboard is a separate app (Streamlit, one deployment for all mills)
 * which picks the mill from its own query string. All this app has to know is
 * the address and the unit's code; everything shown inside is the dashboard's.
 *
 * `embed=true` is Streamlit's own flag for being framed: it drops the toolbar,
 * the footer and the outer padding, so what we frame is the dashboard itself
 * rather than a page with a second app's chrome around it. Following the link
 * out to a full tab deliberately leaves it off.
 */

const BASE_URL =
  import.meta.env.VITE_ANALYTICS_URL ?? "https://analytics.geotranstech.com";

/**
 * Where a unit's dashboard lives, or null if the unit has no code yet — the
 * caller then shows nothing rather than a dashboard for the wrong mill.
 */
export function analyticsUrl(
  code: string | null | undefined,
  { embed = false }: { embed?: boolean } = {},
): string | null {
  const unit = (code ?? "").trim();
  if (!unit) return null;

  const url = new URL(BASE_URL);
  // The dashboard accepts several names for this; `unit` is the documented one.
  url.searchParams.set("unit", unit);
  if (embed) url.searchParams.set("embed", "true");
  return url.toString();
}

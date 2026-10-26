/**
 * The application header, shared by every screen.
 *
 * Modelled on the product-shell conventions used by IBM Carbon and Streamlit:
 * a fixed-height, flat bar with no shadow or rounding; the brand at the far
 * left behind a divider; the product name next; then the page's own context;
 * and actions pushed to the right. Nothing competes with the content below it.
 *
 * Having one component rather than a bespoke header per page is what keeps that
 * consistent as screens get added.
 */

import type { ReactNode } from "react";

import { Logo } from "./Logo";

interface AppHeaderProps {
  /** Where the user is, e.g. a plot or village name. */
  title?: string;
  /** Secondary detail under/next to the title. */
  subtitle?: string;
  actions?: ReactNode;
}

export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  return (
    <header className="appbar">
      <div className="appbar-brand">
        <Logo height={22} />
      </div>

      <span className="appbar-product">Crop Analytics</span>

      {title && (
        <div className="appbar-context">
          <span className="appbar-title">{title}</span>
          {subtitle && <span className="appbar-subtitle">{subtitle}</span>}
        </div>
      )}

      <div className="appbar-actions">{actions}</div>
    </header>
  );
}

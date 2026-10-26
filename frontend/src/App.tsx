/**
 * Routing, and the rule that decides which app a signed-in user sees.
 *
 * The four roles get genuinely different apps:
 *   farmer     - their own land: straight to the map, or a short list first if
 *                they hold several plots
 *   unit_head  - every farmer in their unit, and the ability to open any of
 *                them as that farmer sees it
 *   viewer     - the same screen as a unit head, with every unit to choose
 *                from and nothing to change. A read-only admin.
 *   admin      - the management screens, plus the same preview for any farmer
 *                in any unit
 *
 * All four reach the map through the same `/plots/:id` route and the same API,
 * so a preview cannot drift from the real farmer experience. `viewer` shares
 * the unit_head screen outright for the same reason: one screen cannot drift
 * from itself.
 */

import { Navigate, Route, Routes } from "react-router-dom";

import { useAuth } from "./auth";
import { AdminPage } from "./pages/AdminPage";
import { FarmerEntry } from "./pages/FarmerEntry";
import { LoginPage } from "./pages/LoginPage";
import { PlotDetailPage } from "./pages/PlotDetailPage";
import { PlotListPage } from "./pages/PlotListPage";
import { UnitHomePage } from "./pages/UnitHomePage";

export function App() {
  const { role } = useAuth();

  if (role === null) return <LoginPage />;

  if (role === "admin") {
    return (
      <Routes>
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/plots/:plotId" element={<PlotDetailPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    );
  }

  if (role === "unit_head" || role === "viewer") {
    return (
      <Routes>
        <Route path="/unit" element={<UnitHomePage />} />
        <Route path="/plots/:plotId" element={<PlotDetailPage />} />
        <Route path="*" element={<Navigate to="/unit" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/plots/:plotId" element={<PlotDetailPage />} />
      <Route path="/plots" element={<PlotListPage />} />
      <Route path="/" element={<FarmerEntry />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

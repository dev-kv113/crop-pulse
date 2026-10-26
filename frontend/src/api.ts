/**
 * The single place that talks to the backend.
 *
 * Every call goes through `request`, so the auth header, error handling and
 * base URL are defined once rather than repeated at each call site.
 */

import type {
  AdminFarmer,
  AdminLayer,
  AdminStats,
  LayerClass,
  LayerSummary,
  LoginResponse,
  PlotAnalysis,
  PlotDetail,
  PlotSearchPage,
  PlotSummary,
  Unit,
  UnitHead,
  UnitOption,
  UnitSummary,
  Viewer,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8010";

const TOKEN_KEY = "crop-analytics.token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Thrown for any non-2xx response, carrying the message the API sent. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Let the browser set its own multipart boundary for FormData bodies.
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch {
    // fetch only rejects when the request never completed: the API is down, or
    // the browser blocked it because the API did not allow this origin (CORS).
    // Both used to surface as a bare "Something went wrong", which says nothing
    // about where to look.
    // Two different audiences need two different sentences here. In
    // development this is nearly always a misconfiguration you can fix, and
    // naming it saves an hour. In production a farmer can do nothing about it,
    // so they get the same words as the maintenance page nginx serves when the
    // API is down -- the two failures look identical from a phone, and should
    // read identically too.
    throw new ApiError(
      import.meta.env.DEV
        ? `Cannot reach the server at ${BASE_URL}. Check it is running, and ` +
            `that CORS_ORIGINS or CORS_ORIGIN_REGEX allows ${window.location.origin}.`
        : "Back in a few minutes — Crop Analytics is being updated. " +
            "Nothing has been lost.",
      0,
    );
  }

  if (!response.ok) {
    // FastAPI puts the human-readable message in `detail`.
    const message = await response
      .json()
      .then((body) => body.detail ?? response.statusText)
      .catch(() => response.statusText);
    // A dead token should send the user back to the login screen, not show an
    // error they can do nothing about.
    if (response.status === 401) tokenStore.clear();
    // A 5xx is the server's problem, not something the reader typed. Say the
    // same thing the maintenance page says rather than passing a stack-trace
    // fragment to a farmer.
    if (response.status >= 500 && !import.meta.env.DEV) {
      throw new ApiError(
        "Back in a few minutes — Crop Analytics is being updated. " +
          "Nothing has been lost.",
        response.status,
      );
    }
    throw new ApiError(
      typeof message === "string"
        ? message
        : // A 422 from FastAPI carries a list of field errors rather than a
          // sentence. Surfacing the first one beats a generic apology.
          (Array.isArray(message) && message[0]?.msg) ||
          `Request failed (${response.status})`,
      response.status,
    );
  }

  return response.status === 204 ? (undefined as T) : response.json();
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  // ------------------------------------------------------------------ auth --
  requestOtp: (phone: string) =>
    request<{ phone: string; message: string; dev_otp: string | null }>(
      "/api/auth/request-otp",
      { method: "POST", body: json({ phone }) },
    ),

  verifyOtp: (phone: string, code: string) =>
    request<LoginResponse>("/api/auth/verify-otp", {
      method: "POST",
      body: json({ phone, code }),
    }),

  // ---------------------------------------------------------------- farmer --
  myPlots: () => request<PlotSummary[]>("/api/me/plots"),

  plot: (plotId: number) => request<PlotDetail>(`/api/plots/${plotId}`),

  plotLayers: (plotId: number) =>
    request<LayerSummary[]>(`/api/plots/${plotId}/layers`),

  plotAnalysis: (plotId: number, layerId: number) =>
    request<PlotAnalysis>(`/api/plots/${plotId}/analysis/${layerId}`),

  // ------------------------------------------------------- unit head / viewer --
  /** Units the caller may open: all of them for a viewer, one for a unit head. */
  unitList: () => request<UnitOption[]>("/api/unit/list"),

  unitSummary: (unitId?: number) =>
    request<UnitSummary>(
      unitId ? `/api/unit/me?unit_id=${unitId}` : "/api/unit/me",
    ),

  unitPlots: (search: string, offset = 0, limit = 50, unitId?: number) => {
    const params = new URLSearchParams({
      search,
      offset: String(offset),
      limit: String(limit),
    });
    if (unitId) params.set("unit_id", String(unitId));
    return request<PlotSearchPage>(`/api/unit/plots?${params}`);
  },

  // ----------------------------------------------------------------- admin --
  adminStats: () => request<AdminStats>("/api/admin/stats"),

  adminUnits: () => request<Unit[]>("/api/admin/units"),

  adminRenameUnit: (unitId: number, name: string) =>
    request<Unit>(`/api/admin/units/${unitId}`, {
      method: "PUT",
      body: json({ name }),
    }),

  /** `code` of null or "" unlinks the unit from the monitoring dashboard. */
  adminSetUnitAnalytics: (unitId: number, code: string | null) =>
    request<Unit>(`/api/admin/units/${unitId}/analytics`, {
      method: "PUT",
      body: json({ code: code || null }),
    }),

  adminLayers: (unitId?: number) =>
    request<AdminLayer[]>(
      unitId ? `/api/admin/layers?unit_id=${unitId}` : "/api/admin/layers",
    ),

  adminLayerClasses: (layerId: number) =>
    request<LayerClass[]>(`/api/admin/layers/${layerId}/classes`),

  adminSetLayerClasses: (
    layerId: number,
    classes: { class_id: number; label: string; color: string }[],
  ) =>
    request<LayerClass[]>(`/api/admin/layers/${layerId}/classes`, {
      method: "PUT",
      body: json({ classes }),
    }),

  adminUploadLayer: (form: FormData) =>
    request<AdminLayer>("/api/admin/layers", { method: "POST", body: form }),

  adminUpdateLayer: (layerId: number, changes: Record<string, unknown>) =>
    request<AdminLayer>(`/api/admin/layers/${layerId}`, {
      method: "PATCH",
      body: json(changes),
    }),

  adminDeleteLayer: (layerId: number) =>
    request<void>(`/api/admin/layers/${layerId}`, { method: "DELETE" }),

  adminImportPlots: (form: FormData) =>
    request<{ message: string; plots_imported: number; phones_found: number }>(
      "/api/admin/plots/import",
      { method: "POST", body: form },
    ),

  adminPlots: (search: string, unitId?: number, offset = 0, limit = 50) => {
    const params = new URLSearchParams({
      search,
      offset: String(offset),
      limit: String(limit),
    });
    if (unitId) params.set("unit_id", String(unitId));
    return request<PlotSearchPage>(`/api/admin/plots?${params}`);
  },

  adminViewers: () => request<Viewer[]>("/api/admin/viewers"),

  adminAddViewer: (phone: string, name?: string) =>
    request<Viewer>("/api/admin/viewers", {
      method: "POST",
      body: json({ phone, name }),
    }),

  adminRemoveViewer: (viewerId: number) =>
    request<void>(`/api/admin/viewers/${viewerId}`, { method: "DELETE" }),

  adminUnitHeads: (unitId: number) =>
    request<UnitHead[]>(`/api/admin/units/${unitId}/heads`),

  adminAddUnitHead: (unitId: number, phone: string, name?: string) =>
    request<UnitHead>(`/api/admin/units/${unitId}/heads`, {
      method: "POST",
      body: json({ phone, name }),
    }),

  adminRemoveUnitHead: (unitId: number, headId: number) =>
    request<void>(`/api/admin/units/${unitId}/heads/${headId}`, {
      method: "DELETE",
    }),

  adminFarmers: (search: string) =>
    request<AdminFarmer[]>(
      `/api/admin/farmers?search=${encodeURIComponent(search)}`,
    ),

  adminSetFarmerPhone: (farmerId: number, phone: string) =>
    request<AdminFarmer>(`/api/admin/farmers/${farmerId}/phone`, {
      method: "PUT",
      body: json({ phone }),
    }),
};

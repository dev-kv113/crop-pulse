/** Mirrors the response models in backend/app/models.py. */

export interface FarmerProfile {
  id: number;
  farm_code: string;
  name: string | null;
  phone: string | null;
  plot_count: number;
  unit_count: number;
  total_area_acres: number;
  total_area_ha: number;
}

export interface PlotSummary {
  id: number;
  uniq_id: string;
  village: string | null;
  area_name: string | null;
  variety: string | null;
  unit_name: string | null;
  /** What the mill recorded at survey time. */
  survey_area_acres: number | null;
  survey_area_ha: number | null;
  /** Measured from the boundary coordinates themselves. */
  mapped_area_acres: number | null;
  mapped_area_ha: number | null;
  /** [longitude, latitude] */
  centroid: [number, number];
}

export interface PlotDetail extends PlotSummary {
  /** Whose land this is. Used by the admin preview banner. */
  farmer_name: string | null;
  farm_code: string | null;
  zone: string | null;
  survey_date: string | null;
  attributes: Record<string, unknown>;
  boundary: GeoJSON.FeatureCollection;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
}

export interface AnalysisClass {
  class_id: number;
  label: string;
  /** The numeric density band, e.g. "0.33 - 0.42". */
  detail: string | null;
  class_name: string;
  color: string;
}

export interface LayerSummary {
  id: number;
  name: string;
  capture_date: string;
  description: string | null;
  classes: AnalysisClass[];
}

export interface ClassBreakdown {
  class_id: number;
  label: string;
  detail: string | null;
  color: string;
  area_ha: number;
  percent: number;
}

export interface PlotAnalysis {
  layer: LayerSummary;
  plot_id: number;
  covered_area_ha: number;
  breakdown: ClassBreakdown[];
  geojson: GeoJSON.FeatureCollection;
}

export type Role = "farmer" | "unit_head" | "viewer" | "admin";

export interface UnitContext {
  id: number;
  name: string;
  head_name: string | null;
}

export interface LoginResponse {
  token: string;
  role: Role;
  farmer: FarmerProfile | null;
  unit: UnitContext | null;
}

export interface UnitSummary {
  id: number;
  name: string;
  plot_count: number;
  farmer_count: number;
  farmers_with_login: number;
  layer_count: number;
  /** Which mill this unit is in the monitoring dashboard, e.g. "DEO". */
  analytics_code: string | null;
}

/** Someone who may see every unit and change nothing. */
export interface Viewer {
  id: number;
  phone: string;
  name: string | null;
}

/** One entry in a viewer's unit picker. */
export interface UnitOption {
  id: number;
  name: string;
  analytics_code: string | null;
  plot_count: number;
  farmer_count: number;
}

export interface UnitHead {
  id: number;
  phone: string;
  name: string | null;
  unit_id: number;
  unit_name: string;
}

/** One page of plot-search results, with the true total behind it. */
export interface PlotSearchPage {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  results: AdminPlot[];
}

export interface AdminLayer {
  id: number;
  unit_id: number | null;
  unit_name: string | null;
  name: string;
  capture_date: string;
  description: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  is_published: boolean;
  source_filename: string | null;
  source_srid: number | null;
  feature_count: number;
  clipped_count: number;
  created_at: string;
  processed_at: string | null;
}

export interface Unit {
  id: number;
  name: string;
  plot_count: number;
  layer_count: number;
  /** How many people oversee this unit. A unit may have several. */
  head_count: number;
  /** Which mill this unit is in the monitoring dashboard, e.g. "DEO". */
  analytics_code: string | null;
}

export interface LayerClass {
  class_id: number;
  label: string;
  detail: string | null;
  color: string;
  class_name: string;
  sort_order: number;
}

/** A plot as listed on the admin screen, for previewing a farmer's view. */
export interface AdminPlot {
  id: number;
  uniq_id: string;
  village: string | null;
  variety: string | null;
  computed_area_ha: number | null;
  farmer_name: string | null;
  farm_code: string | null;
  phone: string | null;
  unit_name: string | null;
  layer_count: number;
}

export interface AdminStats {
  farmers: number;
  farmers_with_phone: number;
  plots: number;
  layers: number;
  published_layers: number;
  analysis_pieces: number;
  units: number;
}

export interface AdminFarmer {
  id: number;
  farm_code: string;
  name: string | null;
  phone: string | null;
  plot_count: number;
}

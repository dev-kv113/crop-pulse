/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ANALYTICS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Minimal GeoJSON types.
 *
 * The app only ever passes these objects from the API straight to MapLibre
 * without inspecting their contents, so full typings would be weight for
 * nothing.
 */
declare namespace GeoJSON {
  interface FeatureCollection {
    type: "FeatureCollection";
    features: unknown[];
  }
}

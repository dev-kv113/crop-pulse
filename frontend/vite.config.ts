import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),

    // Turns the built site into an installable app: a home-screen icon that
    // opens full screen, with no browser address bar. No app store involved.
    VitePWA({
      // "autoUpdate": when a new version is deployed, the service worker fetches
      // it in the background and the next open runs the new code. Farmers never
      // have to reinstall anything, which is the main reason for choosing this
      // over a native app.
      registerType: "autoUpdate",

      // Ship the icons and the manifest itself alongside the build output.
      includeAssets: ["icons/apple-touch-icon.png", "icons/favicon-48.png"],

      manifest: {
        name: "Crop Analytics",
        // Shown under the icon on the home screen - keep it short or Android
        // truncates it.
        short_name: "Crop Analytics",
        description:
          "See your sugarcane plots on satellite imagery, with survey layers by date.",
        lang: "en-IN",
        // "standalone" is what removes the browser chrome and makes it feel
        // like an app rather than a bookmark.
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        theme_color: "#1e1a5f",
        background_color: "#1e1a5f",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Android crops icons to the launcher's shape. The maskable versions
          // keep the artwork inside a safe zone so nothing important is cut off.
          {
            src: "icons/icon-192-maskable.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },

      workbox: {
        // Files stored on the device so the app opens instantly, and shows a
        // real screen rather than a browser error when the network is poor.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // MapLibre is ~950 KB. The default 2 MB limit would silently skip it.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // The app uses hash routing, so every path resolves to index.html.
        navigateFallback: "index.html",

        runtimeCaching: [
          {
            // Never cache the API. Plot data, layers and auth must be current,
            // and a stale reply would be worse than an honest error.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          {
            // Map tiles are immutable and expensive on a rural connection, so
            // revisiting a plot costs nothing after the first look.
            urlPattern: ({ url }) =>
              url.hostname.includes("arcgisonline.com") ||
              url.hostname.includes("maptiler.com"),
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: {
                // ~200 tiles is a few plots' worth; roughly 3 MB.
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },

      devOptions: {
        // Without this there is no manifest and no service worker on the dev
        // server, so the browser never offers to install and the Install button
        // can never appear. Turning it on lets you check install behaviour with
        // `npm run dev` rather than having to build first.
        //
        // If a stale file ever seems to survive a change, it is this: in
        // DevTools use Application -> Service Workers -> Unregister, or tick
        // "Bypass for network".
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
      },
    }),
  ],

  optimizeDeps: {
    // MapLibre ships its own web worker as a separate entry point, which Vite's
    // dependency pre-bundler tries to rewrite and then cannot find:
    //   "maplibre-gl-worker.mjs ... does not exist ... in the optimize deps directory"
    // The worker then fails to start and the map renders nothing. Leaving
    // MapLibre out of pre-bundling lets it load its worker the way it expects.
    exclude: ["maplibre-gl"],
  },

  server: {
    // 5174 rather than Vite's default 5173, which is often already in use.
    port: 5174,
    // `host: true` exposes the dev server on your local network, so you can open
    // the app on a real phone's browser while developing.
    host: true,
  },

  build: {
    outDir: "dist",
  },
});

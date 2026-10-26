import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";

import { App } from "./App";
import { AuthProvider } from "./auth";
import "./styles.css";

// HashRouter rather than BrowserRouter: the packaged Android app loads the page
// from the filesystem, where path-based routing has no server to fall back on.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
  </StrictMode>,
);

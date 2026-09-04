import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router";

import "./globals.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// The Mac shell loads the app from a file:// URL, where there is no server to
// fall back to index.html on a deep link or a reload — so there the route
// lives after the hash, which never leaves the page. On the web the paths
// stay clean.
const Router =
  typeof window !== "undefined" && "electron" in window ? HashRouter : BrowserRouter;

createRoot(root).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>,
);

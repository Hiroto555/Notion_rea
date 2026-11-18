import React from "react";
import { createRoot } from "react-dom/client";
import { StartupApp } from "./StartupApp";
import { createDesktopRootBindings } from "./desktop-api";
import "./styles.css";
const desktop = createDesktopRootBindings(window.folio);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupApp desktop={desktop} />
  </React.StrictMode>,
);

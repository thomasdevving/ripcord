import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, readTheme } from "./theme.js";
import "./styles.css";

// Before the first paint, so a light-mode reader never sees a dark flash.
applyTheme(readTheme());

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

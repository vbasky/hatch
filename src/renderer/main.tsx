import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import * as hatchUi from "../ui";
import { installWidgetHostShims } from "./widget-host-shim";
import { installTauriHatch } from "./tauri-bridge";
import "../ui/styles.css";
import "./styles.css";

if (import.meta.env.DEV) {
  void import("../ui/styles.dev.css");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

function applyPrefersColorScheme() {
  const light = window.matchMedia?.("(prefers-color-scheme: light)")?.matches === true;
  const mode = light ? "light" : "dark";
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    el.dataset.theme = mode;
    el.style.colorScheme = mode;
    el.classList.toggle("light", light);
    el.classList.toggle("dark", !light);
  }
}
applyPrefersColorScheme();
window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener("change", applyPrefersColorScheme);

installWidgetHostShims(window, React, jsxRuntime, hatchUi);

try {
  if ("__TAURI_INTERNALS__" in window || import.meta.env.PROD || window.location.protocol.startsWith("http")) {
    installTauriHatch();
  }
} catch (error) {
  console.error("[hatch] failed to install Tauri bridge", error);
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

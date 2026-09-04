import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/app";
import "./styles/foundation.css";
import "./styles/shell.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Tauri application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

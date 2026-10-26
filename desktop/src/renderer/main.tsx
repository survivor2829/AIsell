import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LaunchUpdateGate } from "./LaunchUpdateGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LaunchUpdateGate>
      <App />
    </LaunchUpdateGate>
  </React.StrictMode>
);

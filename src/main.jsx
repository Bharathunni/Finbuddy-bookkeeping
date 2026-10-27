import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { KEY } from "./config.js";
import ErrorBoundary from "./ErrorBoundary.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary storageKey={KEY}>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

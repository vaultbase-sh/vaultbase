import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrimeReactProvider } from "primereact/api";
import "primereact/resources/themes/lara-dark-cyan/theme.css";
import "primereact/resources/primereact.css";
import "primeicons/primeicons.css";
import "quill/dist/quill.snow.css";
import "leaflet/dist/leaflet.css";
import App from "./App.tsx";
import { applyThemeOverrides } from "./theme.ts";

// Fire-and-forget. Login screen gets the operator's branding too.
void applyThemeOverrides();

const root = document.getElementById("root");
if (!root) throw new Error("No root element");
createRoot(root).render(
  <StrictMode>
    <PrimeReactProvider value={{ ripple: true }}>
      <App />
    </PrimeReactProvider>
  </StrictMode>
);

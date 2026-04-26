import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrimeReactProvider } from "primereact/api";
import "primereact/resources/themes/lara-dark-cyan/theme.css";
import "primereact/resources/primereact.css";
import "primeicons/primeicons.css";
import App from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("No root element");
createRoot(root).render(
  <StrictMode>
    <PrimeReactProvider value={{ ripple: true }}>
      <App />
    </PrimeReactProvider>
  </StrictMode>
);

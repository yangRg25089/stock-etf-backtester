import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { applicationRoot } from "./app/applicationRoot";
import "./styles.css";

createRoot(applicationRoot(document)).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

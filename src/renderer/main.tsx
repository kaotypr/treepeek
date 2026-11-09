import { lazy, StrictMode, Suspense, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import { App } from "./app/App";
import { DIFF_LAB_HASH, LAB_ENABLED } from "./dev/lab-enabled";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

// Only a development or lab build keeps this import; production builds drop the branch.
const DiffLab = LAB_ENABLED
  ? lazy(() => import("./dev/diff-lab/DiffLab").then((module) => ({ default: module.DiffLab })))
  : null;

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function Root() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  if (DiffLab !== null && hash === DIFF_LAB_HASH) {
    return (
      <Suspense fallback={null}>
        <DiffLab />
      </Suspense>
    );
  }
  return <App />;
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

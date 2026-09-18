import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { BrowserRouter, Routes, Route } from "react-router";
import WateringCan from "./WateringCan.tsx";
import { Flower } from "./Flower.tsx";
import { SseDemo } from "./SseDemo.tsx";
import { Debug } from "./Debug.tsx";
import { ReceiptPrinter } from "./TestGround/ReceiptPrinter.tsx";
// Lazy: pulls in three.js (~160 KB gz), which no other route needs.
// eslint-disable-next-line react-refresh/only-export-components
const FlowerShake = lazy(() => import("./FlowerShake.tsx"));
// eslint-disable-next-line react-refresh/only-export-components
const FlowerLive = lazy(() => import("./FlowerLive.tsx"));
// eslint-disable-next-line react-refresh/only-export-components
const FlowerToon = lazy(() => import("./FlowerToon.tsx"));

console.log(Flower);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/watering-can" element={<WateringCan />} />
        <Route path="/flower" element={<Flower />} />
        <Route
          path="/flower-shake"
          element={
            <Suspense fallback={null}>
              <FlowerShake />
            </Suspense>
          }
        />
        <Route
          path="/live"
          element={
            <Suspense fallback={null}>
              <FlowerLive />
            </Suspense>
          }
        />
        <Route
          path="/flower-toon"
          element={
            <Suspense fallback={null}>
              <FlowerToon />
            </Suspense>
          }
        />
        <Route path="/sse" element={<SseDemo />} />
        <Route path="/debug" element={<Debug />} />
        <Route path="/test/receipt-printer" element={<ReceiptPrinter />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

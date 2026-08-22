import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { BrowserRouter, Routes, Route } from "react-router";
import WateringCan from "./WateringCan.tsx";
import { Flower } from "./Flower.tsx";
import { SseDemo } from "./SseDemo.tsx";

console.log(Flower);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/watering-can" element={<WateringCan />} />
        <Route path="/flower" element={<Flower />} />
        <Route path="/sse" element={<SseDemo />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

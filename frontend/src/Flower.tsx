import { useEffect, useRef, useState } from "react";

import { Rain, type RainHandle } from "./Rain";

import flowerNeutral256 from "./assets/flower/FlowerNeutral-256.webp";
import flowerNeutral512 from "./assets/flower/FlowerNeutral-512.webp";
import flowerNeutral1024 from "./assets/flower/FlowerNeutral-1024.webp";
import flowerNeutral2048 from "./assets/flower/FlowerNeutral-2048.webp";
import flowerSad256 from "./assets/flower/FlowerSad-256.webp";
import flowerSad512 from "./assets/flower/FlowerSad-512.webp";
import flowerSad1024 from "./assets/flower/FlowerSad-1024.webp";
import flowerSad2048 from "./assets/flower/FlowerSad-2048.webp";
import flowerHappy256 from "./assets/flower/FlowerHappy-256.webp";
import flowerHappy512 from "./assets/flower/FlowerHappy-512.webp";
import flowerHappy1024 from "./assets/flower/FlowerHappy-1024.webp";
import flowerHappy2048 from "./assets/flower/FlowerHappy-2048.webp";
import flowerDead256 from "./assets/flower/FlowerDead-256.webp";
import flowerDead512 from "./assets/flower/FlowerDead-512.webp";
import flowerDead1024 from "./assets/flower/FlowerDead-1024.webp";
import flowerDead2048 from "./assets/flower/FlowerDead-2048.webp";

// While happy, alternate the displayed image on this interval -- a light
// "delighted" bounce rather than a static pose.
const HAPPY_OSCILLATION_MS = 200;
// FlowerHappy renders a touch bigger than FlowerNeutral each time it's the
// one on screen, so the oscillation reads as a little pulse/bounce.
const HAPPY_SCALE = 1.08;
// Fill as much of the viewport's height as possible. Cap the base (unscaled)
// size below 100vh so the happy pulse -- which scales up by HAPPY_SCALE --
// still peaks at exactly 100vh instead of overshooting it.
const MAX_HEIGHT_VH = 100 / HAPPY_SCALE;
// The images are square, so the rendered width tracks the height cap unless
// the viewport itself is narrower.
const IMG_SIZES = `min(100vw, ${MAX_HEIGHT_VH}vh)`;

type Mood = "happy" | "neutral" | "sad" | "dead";

const MOODS: readonly Mood[] = ["happy", "neutral", "sad", "dead"];

// Debug hook: `?debug=true` shows an overlay menu for inspecting and changing
// the flower's mood by hand.
function isDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("debug") === "true";
}

const MOOD_IMAGES: Record<
  Exclude<Mood, "dead"> | "dead",
  { srcSet: string; src: string }
> = {
  neutral: {
    src: flowerNeutral1024,
    srcSet: `${flowerNeutral256} 256w, ${flowerNeutral512} 512w, ${flowerNeutral1024} 1024w, ${flowerNeutral2048} 2048w`,
  },
  sad: {
    src: flowerSad1024,
    srcSet: `${flowerSad256} 256w, ${flowerSad512} 512w, ${flowerSad1024} 1024w, ${flowerSad2048} 2048w`,
  },
  happy: {
    src: flowerHappy1024,
    srcSet: `${flowerHappy256} 256w, ${flowerHappy512} 512w, ${flowerHappy1024} 1024w, ${flowerHappy2048} 2048w`,
  },
  dead: {
    src: flowerDead1024,
    srcSet: `${flowerDead256} 256w, ${flowerDead512} 512w, ${flowerDead1024} 1024w, ${flowerDead2048} 2048w`,
  },
};

export function Flower() {
  // Read once on mount; toggling the query param requires a reload, which is
  // fine for a debug switch.
  const [debug] = useState(isDebugEnabled);
  // The mood the live SSE feed last reported. Mood (which image) is now decided
  // entirely by the server from watering recency; the client just displays it.
  const [liveMood, setLiveMood] = useState<Mood>("neutral");
  // In debug mode you can pin the display to a mood by hand; null means "track
  // the live feed". The displayed mood is derived from the two below.
  const [overrideMood, setOverrideMood] = useState<Mood | null>(null);
  const mood = overrideMood ?? liveMood;
  // Presence drives the *bounce*, not the mood: whenever someone is in frame the
  // flower pulses in whatever mood it's currently in (dead included).
  const [personInFrame, setPersonInFrame] = useState(false);
  // Toggles the pulse scale while bouncing; every state uses the same pulse.
  const [pulse, setPulse] = useState(false);

  const pageRef = useRef<HTMLDivElement | null>(null);
  const rainRef = useRef<RainHandle | null>(null);

  // Preload the initial (neutral) frame at a reasonable mid-resolution so
  // first paint doesn't wait on the full responsive image negotiation.
  const preloadedRef = useRef(false);
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = flowerNeutral512;
    link.imageSrcset = MOOD_IMAGES.neutral.srcSet;
    link.imageSizes = IMG_SIZES;
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  // SSE event listener responsible for changing mood
  useEffect(() => {
    const es = new EventSource("/api/events");

    const push = (event: string) => (e: MessageEvent) => {
      if (event === "mood") {
        // Server-computed health state (happy/neutral/sad/dead).
        const data = JSON.parse(e.data);
        setLiveMood(data.mood);
        console.log("SSE | Mood event received:", data.mood);
      } else if (event === "person") {
        // Presence only toggles the bounce; it never changes the mood.
        const data = JSON.parse(e.data);
        setPersonInFrame(Boolean(data.inFrame));
        console.log("SSE | Person event received:", data.inFrame);
      } else if (event === "pour") {
        // Live "the can is tipped right now" signal: rain for as long as it
        // lasts. Mood is still the server's call -- this only drives rain.
        const data = JSON.parse(e.data);
        rainRef.current?.setRaining(Boolean(data.pouring));
      } else if (event === "watering") {
        // A completed pour. Mood is derived server-side so this doesn't touch
        // it, but it still earns one pass of rain -- and it's the only signal
        // the debug water button sends, which never emits `pour`.
        rainRef.current?.start();
      }
    };

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("mood", push("mood"));
    es.addEventListener("person", push("person"));
    es.addEventListener("pour", push("pour"));
    es.addEventListener("watering", push("watering"));
    return () => es.close();
  }, []);

  // Bounce whenever someone is in frame, regardless of mood. Toggling `pulse`
  // on the oscillation interval drives the scale pulse; when nobody's in frame
  // we hold still at rest scale.
  useEffect(() => {
    if (!personInFrame) {
      setPulse(false);
      return;
    }
    const id = setInterval(() => setPulse((p) => !p), HAPPY_OSCILLATION_MS);
    return () => clearInterval(id);
  }, [personInFrame]);

  const visibleFrame: Mood = mood;

  return (
    <div
      ref={pageRef}
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Rain ref={rainRef} />

      {debug && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: "rgba(0, 0, 0, 0.75)",
            color: "#fff",
            font: "13px/1.4 system-ui, sans-serif",
            zIndex: 1000,
          }}
        >
          <strong
            style={{
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontSize: 12,
              opacity: 0.7,
            }}
          >
            Debug
          </strong>
          <span
            style={{
              width: 1,
              alignSelf: "stretch",
              background: "rgba(255,255,255,0.3)",
            }}
          />
          <span>
            mood: {mood}
            {overrideMood ? " (override)" : ""}
          </span>
          <span style={{ opacity: 0.6 }}>live: {liveMood}</span>
          <span style={{ flex: 1 }} />
          {MOODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setOverrideMood(m)}
              style={{
                padding: "4px 10px",
                borderRadius: 4,
                border: "1px solid #fff",
                background: overrideMood === m ? "#fff" : "transparent",
                color: overrideMood === m ? "#000" : "#fff",
                cursor: "pointer",
              }}
            >
              {m}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOverrideMood(null)}
            disabled={!overrideMood}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid #7CFC7C",
              background: !overrideMood ? "#7CFC7C" : "transparent",
              color: !overrideMood ? "#000" : "#7CFC7C",
              cursor: overrideMood ? "pointer" : "default",
              opacity: overrideMood ? 1 : 0.8,
            }}
          >
            actual
          </button>
        </div>
      )}
      {/* All frames stay mounted (stacked in one grid cell) so switching
          moods never triggers a new image request; only visibility toggles.
          Using visibility rather than display keeps the transform transition
          animating on the presence pulse. */}
      <div style={{ display: "grid", justifyItems: "center" }}>
        {(["neutral", "sad", "happy", "dead"] as const).map((frame) => (
          <img
            key={frame}
            src={MOOD_IMAGES[frame].src}
            srcSet={MOOD_IMAGES[frame].srcSet}
            sizes={IMG_SIZES}
            alt={`A ${frame} flower`}
            style={{
              gridArea: "1 / 1",
              visibility: frame === visibleFrame ? "visible" : "hidden",
              maxHeight: `${MAX_HEIGHT_VH}vh`,
              maxWidth: "100%",
              transform: `scale(${frame === visibleFrame && pulse ? HAPPY_SCALE : 1})`,
              transition: `transform ${HAPPY_OSCILLATION_MS}ms ease-in-out`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

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
// Image should never take up more than 80% of the viewport's height. Cap the
// base (unscaled) size below that so the happy pulse -- which scales up by
// HAPPY_SCALE -- still peaks at exactly 80vh instead of overshooting it.
const MAX_HEIGHT_VH = 80 / HAPPY_SCALE;
// The images are square, so the rendered width tracks the height cap unless
// the viewport itself is narrower.
const IMG_SIZES = `min(100vw, ${MAX_HEIGHT_VH}vh)`;

type Mood = "happy" | "neutral" | "sad" | "dead";

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
  const [mood, setMood] = useState<Mood>("neutral");
  const [wateredAt, setWateredAt] = useState<number | null>(null);
  // While happy, the visible frame alternates between "happy" and "neutral"
  // to produce the pulse/bounce; every other mood is a static frame.
  const [oscFrame, setOscFrame] = useState<"happy" | "neutral">("happy");

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
      console.log("SSE event:ingested", e);
      if (event === "mood") {
        const data = JSON.parse(e.data);
        setMood(data.mood);
      } else if (event == "person") {
        const data = JSON.parse(e.data);
        console.log("data", data);
        setMood(data.inFrame ? "happy" : "neutral");
      } else if (event === "watering") {
        const data = JSON.parse(e.data);
        console.log("watering", data);
        setMood("happy");
        setWateredAt(data.wateredAt ?? Date.now());
      }
    };

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("mood", push("mood"));
    es.addEventListener("person", push("person"));
    es.addEventListener("watering", push("watering"));
    return () => es.close();
  }, []);

  // Oscillate the visible frame while happy. The interval always starts on
  // "happy" (set as the initial state below) so we don't need to set it
  // synchronously from the effect body.
  useEffect(() => {
    if (mood !== "happy") return;
    const id = setInterval(() => {
      setOscFrame((frame) => (frame === "happy" ? "neutral" : "happy"));
    }, HAPPY_OSCILLATION_MS);
    return () => clearInterval(id);
  }, [mood]);

  const visibleFrame: Exclude<Mood, "dead"> | "dead" =
    mood === "happy" ? oscFrame : mood;

  return (
    <div>
      <h1>I'm a flower!</h1>
      <p>I am {mood}</p>
      {wateredAt && (
        <p>💧 watered {new Date(wateredAt).toLocaleTimeString()}</p>
      )}
      <div>
        {(["neutral", "sad", "happy", "dead"] as const).map((frame) => (
          <img
            key={frame}
            src={MOOD_IMAGES[frame].src}
            srcSet={MOOD_IMAGES[frame].srcSet}
            sizes={IMG_SIZES}
            alt={`A ${frame} flower`}
            style={{
              display: frame === visibleFrame ? "block" : "none",
              maxHeight: `${MAX_HEIGHT_VH}vh`,
              maxWidth: "100%",
              transform: `scale(${frame === "happy" && visibleFrame === "happy" ? HAPPY_SCALE : 1})`,
              transition: `transform ${HAPPY_OSCILLATION_MS}ms ease-in-out`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

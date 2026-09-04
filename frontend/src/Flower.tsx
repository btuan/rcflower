import { useState, useEffect } from "react";
import flowerNeutral from "../../assets/FlowerNeutral.png";
import flowerSad from "../../assets/FlowerSad.png";
import flowerHappy from "../../assets/FlowerHappy.png";

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

export function Flower() {
  const [mood, setMood] = useState<"happy" | "neutral" | "sad" | "dead">("neutral");
  const [flowerImg, setFlowerImg] = useState(flowerNeutral);
  const [wateredAt, setWateredAt] = useState<number | null>(null);

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

  // Change image shown
  useEffect(() => {
    if (mood === "neutral") {
      setFlowerImg(flowerNeutral);
      return;
    }
    if (mood === "sad") {
      setFlowerImg(flowerSad);
      return;
    }
    if (mood !== "happy") return; // "dead" -- handled directly in the render below

    // Happy: oscillate between FlowerHappy and FlowerNeutral for a bit of life.
    setFlowerImg(flowerHappy);
    const id = setInterval(() => {
      setFlowerImg((img) => (img === flowerHappy ? flowerNeutral : flowerHappy));
    }, HAPPY_OSCILLATION_MS);
    return () => clearInterval(id);
  }, [mood]);

  return (
    <div>
      <h1>I'm a flower!</h1>
      <p>I am {mood}</p>
      {wateredAt && (
        <p>💧 watered {new Date(wateredAt).toLocaleTimeString()}</p>
      )}
      <div>
        {mood === "dead" ? (
          <p>DEAD image is pending</p>
        ) : (
          <img
            src={flowerImg}
            style={{
              maxHeight: `${MAX_HEIGHT_VH}vh`,
              maxWidth: "100%",
              transform: `scale(${flowerImg === flowerHappy ? HAPPY_SCALE : 1})`,
              transition: `transform ${HAPPY_OSCILLATION_MS}ms ease-in-out`,
            }}
          />
        )}
      </div>
    </div>
  );
}

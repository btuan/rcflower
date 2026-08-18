import { useState, useEffect } from "react";
import flowerNeutral from "../../assets/FlowerNeutral.png";
import flowerSad from "../../assets/FlowerSad.png";

export function Flower() {
  const [mood, _] = useState<"happy" | "sad" | "dead">("happy");
  const [flowerImg, setFlowerImg] = useState(flowerNeutral);

  useEffect(() => {
    const id = setInterval(() => {
      if (mood === "happy") {
        setFlowerImg((img) => (img === flowerSad ? flowerNeutral : flowerSad));
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");

    const push =
      (event: string) => (e: MessageEvent<{ mood: "happy" | "sad" }>) => {
        console.log(e);
      };
    // setLines((prev) => [...prev, { event, data: e.data }].slice(-20));

    // es.onopen = () => setStatus("open");
    // es.onerror = () => setStatus("error / reconnecting…");

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("mood", push("mood"));

    return () => es.close();
  }, []);

  return (
    <div>
      <h1>I'm a flower!</h1>
      <div>
        {mood === "dead" ? (
          <p>DEAD image is pending</p>
        ) : (
          <img src={flowerImg} />
        )}
      </div>
    </div>
  );
}

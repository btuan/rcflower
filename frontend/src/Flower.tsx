import { useState, useEffect } from "react";
import flowerNeutral from "../../assets/FlowerNeutral.png";
import flowerSad from "../../assets/FlowerSad.png";
import flowerHappy from "../../assets/FlowerHappy.png";

export function Flower() {
  const [mood, setMood] = useState<"happy" | "sad" | "dead">("happy");
  const [flowerImg, setFlowerImg] = useState(flowerNeutral);

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
        setMood(data.inFrame ? "happy" : "sad");
      }
    };

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("mood", push("mood"));
    es.addEventListener("person", push("person"));
    return () => es.close();
  }, []);

  // Change image shown
  useEffect(() => {
    if (mood === "happy") {
      setFlowerImg(flowerHappy);
    } else if (mood === "sad") {
      setFlowerImg(flowerSad);
    }

    const id = setInterval(() => {
      if (mood === "happy") {
        setFlowerImg((img) =>
          img === flowerHappy ? flowerNeutral : flowerHappy,
        );
      }
    }, 200);
    return () => clearInterval(id);
  }, [mood]);

  return (
    <div>
      <h1>I'm a flower!</h1>
      <p>I am {mood}</p>
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

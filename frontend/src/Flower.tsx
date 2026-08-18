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

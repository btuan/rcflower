<<<<<<< HEAD
import { useState, useEffect } from "react";
import flowerNeutral from "../../assets/FlowerNeutral.png";
import flowerSad from "../../assets/FlowerSad.png";
=======
import { useState } from "react";
import flowerNeutral from "../../assets/FlowerNeutral.png";
>>>>>>> 91b0da4 (flower pic)

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
<<<<<<< HEAD
        I am {mood}
        {mood === "dead" ? (
          <p>DEAD image is pending</p>
        ) : (
          <img src={flowerImg} />
        )}
=======
        I am:
        <br />
        <h2>{mood}</h2>
        <img src={flowerNeutral} />
>>>>>>> 91b0da4 (flower pic)
      </div>
    </div>
  );
}

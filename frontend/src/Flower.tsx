import { useState } from "react";

export function Flower() {
  const mood = useState<"happy" | "sad" | "dead">("happy");

  return (
    <div>
      <h1>I'm a flower!</h1>
      <div>
        I am:
        <br />
        <h2>{mood}</h2>
      </div>
    </div>
  );
}

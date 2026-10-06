import { Link } from "react-router";
import flowerHappy256 from "./assets/flower/FlowerHappy-256.webp";
import flowerHappy512 from "./assets/flower/FlowerHappy-512.webp";
import flowerHappy1024 from "./assets/flower/FlowerHappy-1024.webp";
import flowerHappy2048 from "./assets/flower/FlowerHappy-2048.webp";
import wateringCanCropped256 from "./assets/WateringCan/WateringCanCropped-256.webp";
import wateringCanCropped512 from "./assets/WateringCan/WateringCanCropped-512.webp";
import wateringCanCropped1024 from "./assets/WateringCan/WateringCanCropped-1024.webp";
import wateringCanCropped2048 from "./assets/WateringCan/WateringCanCropped-2048.webp";

// Thumbnails render at ~112-160 CSS px wide.
const IMG_SIZES = "160px";

const MENU_ITEMS = [
  {
    to: "/live",
    label: "Flower",
    src: flowerHappy512,
    srcSet: `${flowerHappy256} 256w, ${flowerHappy512} 512w, ${flowerHappy1024} 1024w, ${flowerHappy2048} 2048w`,
  },
  {
    to: "/watering-can",
    label: "Watering Can",
    src: wateringCanCropped512,
    srcSet: `${wateringCanCropped256} 256w, ${wateringCanCropped512} 512w, ${wateringCanCropped1024} 1024w, ${wateringCanCropped2048} 2048w`,
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <h1
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          // Mirrors the credit line at the bottom: clear of the notch on a
          // notched phone, 24px everywhere else.
          top: "max(24px, env(safe-area-inset-top))",
          margin: 0,
          textAlign: "center",
          font: "600 22px/1.3 system-ui, sans-serif",
          letterSpacing: "0.01em",
          color: "#3d3b36",
          textShadow: "0 1px 2px rgba(255, 255, 255, 0.8)",
          pointerEvents: "none",
          zIndex: 6,
        }}
      >
        RC Flower
      </h1>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-4">
        {MENU_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-4 rounded-2xl border border-current/30 p-4 transition-colors hover:bg-current/5"
          >
            <img
              src={item.src}
              srcSet={item.srcSet}
              sizes={IMG_SIZES}
              alt=""
              className="h-28 w-28 shrink-0 object-contain sm:h-40 sm:w-40"
            />
            <span className="text-2xl font-bold sm:text-3xl">{item.label}</span>
          </Link>
        ))}
      </main>
      <footer className="p-4 text-center text-sm opacity-80">
        Made with ❤️ at Recurse Center ·{" "}
        <a
          href="https://github.com/btuan/rcflower"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Source code on GitHub
        </a>
      </footer>
    </div>
  );
}

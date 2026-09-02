// A small bouquet of ghost-flowers drifts continuously right-to-left,
// each flickering independently, over a faint "haunted static" texture.

const NUM_FLOWERS = 3;
const SPEED = 0.15;
const flowers = [];

function setup() {
  noStroke();
  for (let i = 0; i < NUM_FLOWERS; i++) {
    flowers.push({
      offsetX: i * 26,
      baseY: 10 + i * 9,
      seed: i * 37.5,
    });
  }
}

function drawGhostFlower(x, y, t, seed) {
  const sway = sin(t * 0.08 + seed) * 2;
  const bob = cos(t * 0.11 + seed) * 1.5;
  const fx = x + sway;
  const fy = y + bob;

  const shimmer = noise(seed, t * 0.04);
  const ghostMode = shimmer < 0.35;

  const petals = 6;
  const petalR = 2.5;
  const headR = 3.5;

  fill(0);
  for (let i = 0; i < petals; i++) {
    if (ghostMode && i % 2 === 0) continue;
    const angle = (TWO_PI / petals) * i + t * 0.015;
    const px = fx + cos(angle) * (headR + petalR - 1);
    const py = fy + sin(angle) * (headR + petalR - 1);
    ellipse(px, py, petalR * 2, petalR * 2);
  }

  fill(0);
  ellipse(fx, fy, headR * 2, headR * 2);

  const blink = (t + seed * 10) % 100 < 4;
  fill(255);
  if (!blink) {
    ellipse(fx - 1.2, fy - 0.5, 1, 1);
    ellipse(fx + 1.2, fy - 0.5, 1, 1);
  }
}

function draw() {
  background(255);

  const t = frameCount;
  const wrap = width + 40;

  // sparse flickering "haunted static" dots
  fill(0);
  for (let x = 0; x < width; x += 4) {
    for (let y = 0; y < height; y += 4) {
      const n = noise(x * 0.2, y * 0.2, t * 0.02);
      if (n > 0.82) {
        ellipse(x, y, 1, 1);
      }
    }
  }

  for (const f of flowers) {
    const x = ((width + 20 - t * SPEED + f.offsetX) % wrap) - 20;
    drawGhostFlower(x, f.baseY, t, f.seed);
  }
}

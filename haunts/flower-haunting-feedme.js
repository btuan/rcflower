// A single flower's stem creeps up from the bottom edge, and once grown,
// the wavy words "FEED ME" float and undulate beside it. Loops forever.

const MSG = "FEED ME";
const GROW_FRAMES = 150;
const HOLD_FRAMES = 250;
const CYCLE_FRAMES = GROW_FRAMES + HOLD_FRAMES;

const STEM_X = 18;
const GROUND_Y = 37;
const HEAD_TOP_Y = 10;
const PETALS = 6;
const PETAL_R = 3;
const HEAD_R = 4;

// hand-drawn 5x7 pixel font. vector text turns to noise once thresholded
// to 1-bit at this resolution, so letters are drawn pixel-by-pixel instead.
const FONT = {
  F: [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
  ],
  E: [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ],
  D: [
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
  ],
  M: [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  " ": [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
};

function drawChar(ch, x, y) {
  const glyph = FONT[ch];
  if (!glyph) return 3;
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col]) {
        rect(x + col, y + row, 1, 1);
      }
    }
  }
  return glyph[0].length;
}

function setup() {
  noStroke();
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

function draw() {
  background(255);

  const t = frameCount % CYCLE_FRAMES;
  const growT = Math.min(1, t / GROW_FRAMES);
  const eased = easeOut(growT);

  const headY = lerp(GROUND_Y, HEAD_TOP_Y, eased);
  const sway = growT >= 1 ? sin(frameCount * 0.08) * 2 : 0;
  const hx = STEM_X + sway;

  // stem creeping up from the bottom, gently wavy as it grows
  stroke(0);
  strokeWeight(1);
  noFill();
  beginShape();
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const vt = i / steps;
    const vy = lerp(GROUND_Y, headY, vt);
    const vx = STEM_X + sin(vt * PI * 2 + frameCount * 0.05) * 1.5 * eased;
    vertex(vx, vy);
  }
  endShape();
  noStroke();

  // ghostly flicker on the flower head
  const shimmer = noise(frameCount * 0.05);
  const ghostMode = shimmer < 0.35;

  fill(0);
  for (let i = 0; i < PETALS; i++) {
    if (ghostMode && i % 2 === 0) continue;
    const angle = (TWO_PI / PETALS) * i + frameCount * 0.02;
    const px = hx + cos(angle) * (HEAD_R + PETAL_R - 1);
    const py = headY + sin(angle) * (HEAD_R + PETAL_R - 1);
    ellipse(px, py, PETAL_R * 2, PETAL_R * 2);
  }

  fill(0);
  ellipse(hx, headY, HEAD_R * 2, HEAD_R * 2);

  const blink = frameCount % 90 < 4;
  fill(255);
  if (!blink) {
    ellipse(hx - 1.5, headY - 0.5, 1, 1);
    ellipse(hx + 1.5, headY - 0.5, 1, 1);
  }

  // "FEED ME" floats in letter-by-letter once the flower has mostly grown,
  // each letter bobbing on its own phase for a creepy wavy-text effect
  if (growT > 0.6) {
    const sinceAppear = t - GROW_FRAMES * 0.6;
    const materializing = sinceAppear < 30;
    const flicker = materializing && frameCount % 3 === 0;
    if (!flicker) {
      fill(0);
      let tx = 30;
      const ty = 14;
      for (let i = 0; i < MSG.length; i++) {
        const ch = MSG[i];
        const wobble = Math.round(sin(frameCount * 0.15 + i * 0.7) * 2);
        const w = drawChar(ch, tx, ty + wobble);
        tx += w + 1;
      }
    }
  }
}

// A single ghostly flower creeps in from the left along a wavy vine,
// lingers and flickers like an apparition, then withdraws. Loops forever.

const CYCLE_FRAMES = 420;
const CREEP_FRAMES = 180;
const LINGER_FRAMES = 150;
const RETREAT_FRAMES = CYCLE_FRAMES - CREEP_FRAMES - LINGER_FRAMES;

const RESTING_X = 46;
const HEAD_Y = 18;
const PETALS = 6;
const PETAL_R = 3;
const HEAD_R = 4;

function setup() {
  noStroke();
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function draw() {
  background(255);

  const t = frameCount % CYCLE_FRAMES;

  let headX;
  if (t < CREEP_FRAMES) {
    headX = lerp(-10, RESTING_X, easeInOut(t / CREEP_FRAMES));
  } else if (t < CREEP_FRAMES + LINGER_FRAMES) {
    headX = RESTING_X;
  } else {
    const p = (t - CREEP_FRAMES - LINGER_FRAMES) / RETREAT_FRAMES;
    headX = lerp(RESTING_X, -10, easeInOut(p));
  }

  // gentle haunting sway/bob
  const sway = sin(frameCount * 0.07) * 2;
  const bob = sin(frameCount * 0.13) * 1.5;
  const hx = headX + sway;
  const hy = HEAD_Y + bob;

  // trailing vine from the left edge up to the flower head
  stroke(0);
  strokeWeight(1);
  noFill();
  beginShape();
  const vineSteps = 20;
  for (let i = 0; i <= vineSteps; i++) {
    const vt = i / vineSteps;
    const vx = lerp(-4, hx, vt);
    const vy =
      height - 2 - vt * (height - 2 - hy) +
      sin(vt * PI * 3 + frameCount * 0.1) * 2 * (1 - vt);
    vertex(vx, vy);
  }
  endShape();
  noStroke();

  // ghostly shimmer: alternate petals flicker out
  const shimmer = noise(frameCount * 0.05);
  const ghostMode = shimmer < 0.35;

  fill(0);
  for (let i = 0; i < PETALS; i++) {
    if (ghostMode && i % 2 === 0) continue;
    const angle = (TWO_PI / PETALS) * i + frameCount * 0.02;
    const px = hx + cos(angle) * (HEAD_R + PETAL_R - 1);
    const py = hy + sin(angle) * (HEAD_R + PETAL_R - 1);
    ellipse(px, py, PETAL_R * 2, PETAL_R * 2);
  }

  fill(0);
  ellipse(hx, hy, HEAD_R * 2, HEAD_R * 2);

  // haunted little eyes peeking out of the flower's face, blinking
  const blink = frameCount % 90 < 4;
  fill(255);
  if (!blink) {
    ellipse(hx - 1.5, hy - 0.5, 1, 1);
    ellipse(hx + 1.5, hy - 0.5, 1, 1);
  }
}

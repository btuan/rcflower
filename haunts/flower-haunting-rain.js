// A field of tiny flowers rains down continuously from the top,
// each with its own size, speed, and gentle spin.

const NUM_DROPS = 10;
const drops = [];

function setup() {
  noStroke();
  for (let i = 0; i < NUM_DROPS; i++) {
    drops.push(makeDrop(true));
  }
}

function makeDrop(initial) {
  return {
    x: random(2, width - 2),
    y: initial ? random(-height, height) : random(-20, -2),
    speed: random(0.3, 0.9),
    size: random(2.5, 4),
    spin: random(TWO_PI),
    spinSpeed: random(-0.05, 0.05),
  };
}

function drawTinyFlower(x, y, size, angle) {
  const petals = 4;
  const r = size / 2;
  fill(0);
  for (let i = 0; i < petals; i++) {
    const a = angle + (TWO_PI / petals) * i;
    const px = x + cos(a) * r;
    const py = y + sin(a) * r;
    ellipse(px, py, r, r);
  }
  ellipse(x, y, r, r);
}

function draw() {
  background(255);

  for (const d of drops) {
    d.y += d.speed;
    d.spin += d.spinSpeed;
    if (d.y - d.size > height) {
      const fresh = makeDrop(false);
      d.x = fresh.x;
      d.y = fresh.y;
      d.speed = fresh.speed;
      d.size = fresh.size;
      d.spin = fresh.spin;
      d.spinSpeed = fresh.spinSpeed;
    }
    drawTinyFlower(d.x, d.y, d.size, d.spin);
  }
}

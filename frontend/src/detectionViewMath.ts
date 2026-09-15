/**
 * Pure scaling helpers for DetectionView: detections/roi arrive in full
 * camera-frame pixel coordinates (frameSize), but get drawn on a canvas
 * sized to the (smaller) snapshot image. Scale linearly per axis.
 */

export type Box = readonly [number, number, number, number];
export type Size = readonly [number, number];

/** Maps a [x1,y1,x2,y2] box from frame pixel space into canvas pixel space. */
export function frameToCanvas(box: Box, frameSize: Size, canvasSize: Size): Box {
  const [fw, fh] = frameSize;
  const [cw, ch] = canvasSize;
  if (fw <= 0 || fh <= 0) return [0, 0, 0, 0];
  const sx = cw / fw;
  const sy = ch / fh;
  const [x1, y1, x2, y2] = box;
  return [x1 * sx, y1 * sy, x2 * sx, y2 * sy];
}

/** Maps a single [x,y] point from frame pixel space into canvas pixel space. */
export function pointToCanvas(
  point: readonly [number, number],
  frameSize: Size,
  canvasSize: Size,
): readonly [number, number] {
  const [fw, fh] = frameSize;
  const [cw, ch] = canvasSize;
  if (fw <= 0 || fh <= 0) return [0, 0];
  const [x, y] = point;
  return [x * (cw / fw), y * (ch / fh)];
}

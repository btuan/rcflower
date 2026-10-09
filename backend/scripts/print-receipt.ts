/**
 * Print on the RC receipt printer (https://receipt.recurse.com) using its
 * headless auth: sign the request body with our Ed25519 key and send the
 * base64 signature as the `Signature` header.
 *
 *   bun run print-receipt ../assets/FlowerHappy_768x768.png   # image
 *   bun run print-receipt "hello from the flower"             # text
 *
 * Needs RECEIPT_KEY_PATH (private key PEM) in backend/.env.local.
 */
import { createPrivateKey, sign } from "node:crypto";

const arg = process.argv.slice(2).join(" ");
if (!arg) throw new Error('usage: bun run print-receipt <image path | "text">');

const keyPath = Bun.env.RECEIPT_KEY_PATH;
if (!keyPath) throw new Error("set RECEIPT_KEY_PATH in backend/.env.local");
const key = createPrivateKey(await Bun.file(keyPath).text());

const file = Bun.file(arg);
const [path, body, type] = (await file.exists())
  ? ["/image", await file.bytes(), file.type]
  : ["/text", JSON.stringify({ text: arg }), "application/json"];

// The server verifies the signature against the body decoded as UTF-8, not
// the raw bytes, so sign that same decoding (a no-op for text, lossy for images).
const signed = Buffer.from(Buffer.from(body).toString("utf8"));
const signature = sign(null, signed, key).toString("base64");

const res = await fetch(`https://receipt.recurse.com${path}`, {
  method: "POST",
  headers: { "Content-Type": type, Signature: signature },
  body,
});
console.log(res.status, await res.text());

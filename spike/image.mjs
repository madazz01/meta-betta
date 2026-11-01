// Spike 8i: does the model read images through serve?
// Sends a tiny red PNG plus "What colour is this square? One word." and
// prints the reply. Usage: node image.mjs
import { MuseClient } from "@muse-code/sdk";
import { mkdirSync } from "node:fs";
import zlib from "node:zlib";

const museBin = process.env.MUSE_BIN ?? "muse";
const workspaceRoot = process.env.MUSE_WS ?? "C:\\muse-play\\spike-ws";

// A solid red square, encoded by hand (no image deps).
function redSquare(size) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    raw[y * (1 + size * 3)] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[y * (1 + size * 3) + 1 + x * 3] = 255;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor, no alpha
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const size = 64;
const base64Data = redSquare(size).toString("base64");

mkdirSync(workspaceRoot, { recursive: true });
const t0 = Date.now();
const client = await MuseClient.spawn({
  museBin,
  args: ["serve"],
  clientInfo: { name: "meta_betta_spike", version: "0.0.1" }, // must match ^[a-z0-9_]+$
});
console.log(`[host up in ${Date.now() - t0} ms]`);

const session = await client.startSession({ workspaceRoot });
console.log(`[session ${session.sessionId}]`);

const turn = await session.sendUserTurn({
  input: [
    { type: "text", text: "What colour is this square? One word." },
    { type: "image", mediaType: "image/png", base64Data, width: size, height: size },
  ],
});
for await (const d of turn.deltas()) {
  process.stdout.write(typeof d === "string" ? d : (d.text ?? d.delta ?? ""));
}
const outcome = await turn.completed;
console.log(`\n[turn done: ${JSON.stringify(outcome).slice(0, 300)}]`);
console.log(`[total ${Date.now() - t0} ms]`);
await client.close();

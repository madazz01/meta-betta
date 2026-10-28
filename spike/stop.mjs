// Spike 3: can we really stop a running turn?
// MuseClient keeps its connection private, so we build the client around a
// connection we spawn ourselves (the same steps MuseClient.spawn() takes), keep
// that connection, and send turn/interrupt mid-reply.
// Usage: node stop.mjs
import { MuseClient, spawnMspConnection, readSessionDurability } from "@muse-code/sdk";
import { mkdirSync } from "node:fs";

const museBin = process.env.MUSE_BIN ?? "muse";
const workspaceRoot = process.env.MUSE_WS ?? "C:\\muse-play\\spike-ws";
const stopAfterMs = Number(process.env.STOP_AFTER_MS ?? 4000);

mkdirSync(workspaceRoot, { recursive: true });
const handshake = spawnMspConnection({ command: museBin, args: ["serve"] });
let spawned;
try {
  spawned = await handshake.initialize({ clientInfo: { name: "meta_betta_spike", version: "0.0.1" } });
} catch (error) {
  await handshake.close().catch(() => undefined);
  throw error;
}
const connection = spawned.connection;
const client = new MuseClient(connection, {
  durability: readSessionDurability(spawned.initializeResult),
  host: spawned,
});

const session = await client.startSession({ workspaceRoot });
const turn = await session.sendUserTurn({
  input: [{ type: "text", text: "Write a 1500-word story about a mechanic and a parts counter. No tools." }],
});
console.log(`[turn ${turn.turnId} started, stopping in ${stopAfterMs} ms]`);

let chars = 0;
const stream = (async () => {
  for await (const d of turn.deltas()) chars += (typeof d === "string" ? d : (d.text ?? d.delta ?? "")).length;
})();

await new Promise((r) => setTimeout(r, stopAfterMs));
const t0 = Date.now();
const ack = await connection.command("turn/interrupt", { sessionId: session.sessionId, turnId: turn.turnId });
console.log(`[interrupt ack: ${JSON.stringify(ack)}]`);

const outcome = await Promise.race([
  turn.completed,
  new Promise((r) => setTimeout(() => r({ kind: "TIMEOUT (no terminal in 20s)" }), 20000)),
]);
await stream.catch(() => undefined);
console.log(`[outcome kind: ${outcome.kind}, params: ${JSON.stringify({ ...outcome.params, sourceRange: undefined, viewCursor: undefined })}]`);
console.log(`[stopped ${Date.now() - t0} ms after interrupt, ${chars} chars streamed]`);

// And the session still works afterwards.
const next = await session.sendUserTurn({ input: [{ type: "text", text: "Say just: still here." }] });
let reply = "";
for await (const d of next.deltas()) reply += typeof d === "string" ? d : (d.text ?? d.delta ?? "");
console.log(`[next turn: ${(await next.completed).kind} "${reply.trim()}"]`);
await client.close();

// Spike 5: side question. Does session/sideChat + resumeSession + a turn work?
import { MuseClient, spawnMspConnection, readSessionDurability } from "@muse-code/sdk";
const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const handshake = spawnMspConnection({ command: process.env.MUSE_BIN, args: ["serve", ...(process.env.MUSE_TRUST ? ["--trust-workspace"] : [])] });
const spawned = await handshake.initialize({ clientInfo: { name: "meta_betta_spike", version: "0.0.1" } });
const connection = spawned.connection;
const client = new MuseClient(connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
const main = await client.startSession({ workspaceRoot: process.env.MUSE_WS });
const t1 = await main.sendUserTurn({ input: [{ type: "text", text: "Say just: main ok" }] });
await t1.completed; log("main turn done");
const made = await connection.command("session/sideChat", { sessionId: main.sessionId });
const sideId = made?.session?.sessionId; log(`sideChat -> ${sideId} keys=${Object.keys(made)}`);
const resumed = await Promise.race([
  client.resumeSession({ sessionId: sideId, onApproval: async (req) => { log("APPROVAL ASKED: " + JSON.stringify(req).slice(0, 200)); const c = req.availableChoices.find((x) => /allow|approve|yes/i.test(x.choiceId + " " + (x.label ?? ""))) ?? req.availableChoices[0]; return { choiceId: c.choiceId }; } }).then((s) => ({ s })),
  new Promise((r) => setTimeout(() => r({ timeout: true }), 20000)),
]);
if (resumed.timeout) { log("resumeSession on the side session HUNG (20s)"); process.exit(0); }
log("side resumed");
const turn = await resumed.s.sendUserTurn({ input: [{ type: "text", text: "whats the date today?" }] });
let text = "";
const done = Promise.race([
  (async () => { for await (const d of turn.deltas()) text += typeof d === "string" ? d : (d.text ?? d.delta ?? ""); return turn.completed; })(),
  new Promise((r) => setTimeout(() => r({ kind: "TIMEOUT 60s" }), 60000)),
]);
const outcome = await done; log(`side turn: ${outcome.kind} terminal=${outcome.params?.terminal} text="${text.trim().slice(-80)}"`);
await client.close();

// Spike 1: can our own program drive Muse Code through Meta's SDK?
// Spawns `muse serve`, opens a session in a scratch folder, sends one turn,
// streams the reply. No approval handler, so tool use falls to the server's
// default-deny. Usage: node hello.mjs "<prompt>"
import { MuseClient } from "@muse-code/sdk";
import { mkdirSync } from "node:fs";

const museBin = process.env.MUSE_BIN ?? "muse";
const workspaceRoot = process.env.MUSE_WS ?? "C:\\muse-play\\spike-ws";
const prompt = process.argv[2] ?? "In one short sentence, say hello and tell me which model you are. Don't use any tools.";

mkdirSync(workspaceRoot, { recursive: true });
const t0 = Date.now();
const client = await MuseClient.spawn({
  museBin,
  args: ["serve"],
  clientInfo: { name: "meta_betta_spike", version: "0.0.1" }, // must match ^[a-z0-9_]+$ (the SDK README's "my-app" would be rejected)
});
console.log(`[host up in ${Date.now() - t0} ms]`);

const session = await client.startSession({ workspaceRoot });
console.log(`[session ${session.sessionId}]`);

const turn = await session.sendUserTurn({ input: [{ type: "text", text: prompt }] });
for await (const d of turn.deltas()) process.stdout.write(typeof d === "string" ? d : (d.text ?? d.delta ?? ""));
const outcome = await turn.completed;
console.log(`\n[turn done: ${JSON.stringify(outcome).slice(0, 300)}]`);
console.log(`[total ${Date.now() - t0} ms]`);
await client.close();

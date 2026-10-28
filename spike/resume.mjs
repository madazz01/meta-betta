// Spike 2: does a fresh process resume a session with its history?
// Usage: node resume.mjs <sessionId> "<prompt>"
import { MuseClient } from "@muse-code/sdk";

const museBin = process.env.MUSE_BIN ?? "muse";
const [sessionId, prompt = "What was the first thing I asked you in this session? Answer in one sentence."] = process.argv.slice(2);
if (!sessionId) { console.error("usage: node resume.mjs <sessionId> [prompt]"); process.exit(1); }

const client = await MuseClient.spawn({
  museBin,
  args: ["serve"],
  clientInfo: { name: "meta_betta_spike", version: "0.0.1" },
});
const session = await client.resumeSession({ sessionId });
console.log(`[resumed ${session.sessionId}]`);

const turn = await session.sendUserTurn({ input: [{ type: "text", text: prompt }] });
for await (const item of turn.items()) {
  if (item?.kind === "agentMessage" || item?.type === "agentMessage" || item?.type === "assistant_message") {
    console.log("ANSWER:", item.text ?? JSON.stringify(item).slice(0, 400));
  } else {
    console.log(`[item ${item?.type ?? item?.kind ?? "?"}]`);
  }
}
console.log(`[turn: ${(await turn.completed).kind}]`);
await client.close();

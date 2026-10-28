// Spike 2: does a fresh process resume a session with its history?
// Usage: node resume.mjs <sessionId> "<prompt>"
import { MuseClient } from "@muse-code/sdk";

const museBin = process.env.MUSE_BIN ?? "muse";
const [sessionId, prompt = "What was the first thing I asked you in this session? Answer in one sentence."] = process.argv.slice(2);
if (!sessionId) { console.error("usage: node resume.mjs <sessionId> [prompt]"); process.exit(1); }

const client = await MuseClient.spawn({
  museBin,
  args: ["serve", ...(process.env.MUSE_TRUST ? ["--trust-workspace"] : [])],
  clientInfo: { name: "meta_betta_spike", version: "0.0.1" },
});
// MUSE_ALLOW=1: approve each tool request with its first "allow"-like choice and log it (test only).
const onApproval = process.env.MUSE_ALLOW ? async (req) => {
  const c = req.availableChoices.find((x) => /allow|approve|yes/i.test(`${x.choiceId} ${x.label ?? ""}`)) ?? req.availableChoices[0];
  console.log(`[approval: ${JSON.stringify(req).slice(0, 220)} -> ${c.choiceId}]`);
  return { choiceId: c.choiceId };
} : undefined;
const session = await client.resumeSession({ sessionId, ...(onApproval ? { onApproval } : {}) });
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

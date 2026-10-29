// Spike 4: does a shell command work when our code drives Muse? (sandbox check)
import { MuseClient } from "@muse-code/sdk";
const client = await MuseClient.spawn({
  museBin: process.env.MUSE_BIN ?? "muse",
  args: ["serve", ...(process.env.MUSE_TRUST ? ["--trust-workspace"] : [])],
  clientInfo: { name: "meta_betta_spike", version: "0.0.1" },
});
const session = await client.startSession({ workspaceRoot: process.env.MUSE_WS });
session.onApproval(async (req) => {
  const c = req.availableChoices.find((x) => /allow|approve|yes/i.test(`${x.choiceId} ${x.label ?? ""}`)) ?? req.availableChoices[0];
  return { choiceId: c.choiceId };
});
const turn = await session.sendUserTurn({ input: [{ type: "text", text: "Run the shell command `echo sandbox-ok` with your shell tool and tell me the exact output, or the exact error." }] });
for await (const item of turn.items()) {
  if (item?.kind === "toolCall") console.log("[tool]", JSON.stringify(item).match(/(sandbox[^"]{0,160}|"status":"[a-z]+")/g)?.slice(0, 3));
  if (item?.kind === "agentMessage") console.log("ANSWER:", (item.text ?? "").slice(0, 300));
}
await turn.completed;
await client.close();

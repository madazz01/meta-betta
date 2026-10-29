// Spike 6: with the sandbox off (Windows workaround), does Muse still ask before
// shell commands? Selects an approval mode, then logs every approval request.
// Usage: APPROVAL_MODE=promptUnmatched node approvalmode.mjs
import { MuseClient, spawnMspConnection, readSessionDurability } from "@muse-code/sdk";

const museBin = process.env.MUSE_BIN ?? "muse";
const workspaceRoot = process.env.MUSE_WS ?? "C:\mb-test";
const mode = process.env.APPROVAL_MODE ?? "promptUnmatched";

const handshake = spawnMspConnection({ command: museBin, args: ["serve", "--disable-sandbox"] });
const spawned = await handshake.initialize({ clientInfo: { name: "meta_betta_spike", version: "0.0.1" } });
const connection = spawned.connection;
const client = new MuseClient(connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });

const session = await client.startSession({ workspaceRoot });
console.log("start mode:", JSON.stringify(session.snapshot?.approvalMode ?? session.approvalMode ?? null));
try {
  const result = await connection.command("session/setApprovalMode", { sessionId: session.sessionId ?? session.id, mode });
  console.log("set", mode, "->", JSON.stringify(result));
} catch (error) {
  console.log("set", mode, "failed:", error?.message ?? error);
}
let asked = 0;
session.onApproval(async (req) => {
  asked += 1;
  console.log("[approval]", JSON.stringify(req.availableChoices));
  const c = req.availableChoices.find((x) => /^approved$|allow once|approve$/i.test(`${x.choiceId} ${x.label ?? ""}`)) ?? req.availableChoices[0];
  return { choiceId: c.choiceId };
});
const turn = await session.sendUserTurn({ input: [{ type: "text", text: "Use your shell tool to run: New-Item -ItemType Directory mb-probe-dir; Remove-Item mb-probe-dir; Write-Output sandbox-ok . Then tell me the exact output." }] });
for await (const item of turn.items()) {
  if (item?.kind === "agentMessage" && item.text) console.log("ANSWER:", item.text.slice(0, 200));
}
await turn.completed;
console.log("approvals asked:", asked);
await client.close();

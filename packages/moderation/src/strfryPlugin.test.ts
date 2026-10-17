import { expect, test } from "bun:test";
import { runPlugin } from "./strfryPlugin";
const id = "ab".repeat(32);
async function* input(lines: string[]) { for (const line of lines) yield Buffer.from(line); }

test("JSONL emits only decisions and does not disclose source metadata", async () => {
  const output: string[] = [];
  await runPlugin(input(['{"type":"new","event":{"id":"' + id + '"},"sourceInfo":"synthetic-source","authed":"test"}\n']), (line) => { output.push(line); }, async () => ({ id, action: "accept" }));
  expect(output).toEqual([JSON.stringify({ id, action: "accept" }) + "\n"]);
});
test("malformed and oversized lines are bounded and subsequent input still works", async () => {
  const output: string[] = [];
  await runPlugin(input(["{bad}\n", "x".repeat(200_000), "\n", JSON.stringify({ type: "new", event: { id } }) + "\n"]), (line) => { output.push(line); }, async () => ({ id, action: "accept" }));
  expect(output).toHaveLength(3);
  expect(output.map((line) => JSON.parse(line).action)).toEqual(["reject", "reject", "accept"]);
  expect(output.join("")).not.toContain("xxxxx");
});
test("timeout and thrown exceptions reject without logging payloads", async () => {
  for (const admit of [async () => { throw new Error("sensitive synthetic payload"); }, () => new Promise<never>(() => {})]) {
    const output: string[] = [];
    await runPlugin(input([JSON.stringify({ type: "new", event: { id } }) + "\n"]), (line) => { output.push(line); }, admit, { timeoutMs: 5 });
    expect(JSON.parse(output[0]).action).toBe("reject");
    expect(output[0]).not.toContain("sensitive");
  }
});
test("rate limits before invoking cryptography", async () => {
  let calls = 0;
  const output: string[] = [];
  const request = JSON.stringify({ type: "new", event: { id, pubkey: "cd".repeat(32) } }) + "\n";
  await runPlugin(input([request.repeat(3)]), (line) => { output.push(line); }, async () => { calls++; return { id, action: "accept" }; }, { burst: 2 });
  expect(calls).toBe(2);
  expect(JSON.parse(output[2]).action).toBe("reject");
});

import { expect, test } from "bun:test";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { validateWorkerCommunity } from "./runtime";
test("worker provisioning rejects an owner signer and private channel material", async () => {
  const f = await moderationFixture();
  expect(() => validateWorkerCommunity(f.community, f.owner.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity({ ...f.community, privateChannels: [{} as any] }, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity(f.community, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).not.toThrow();
});

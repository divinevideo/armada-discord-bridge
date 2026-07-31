import { describe, expect, it } from "bun:test";

import { ADMIN_ALL, Permissions } from "@armada-bridge/concord-core";

import type { GuildSnapshot, SnapshotChannel, SnapshotRole } from "./discordRest";
import { buildImportPlan, capName, mapRolePermissions, MAX_IMPORTED_ROLES } from "./importPlan";

const GUILD_ID = "100";

function role(partial: Partial<SnapshotRole> & { id: string; name: string }): SnapshotRole {
  return { permissions: "0", color: 0, hoist: false, position: 0, managed: false, ...partial };
}

function channel(partial: Partial<SnapshotChannel> & { id: string; name: string; type: number }): SnapshotChannel {
  return { position: 0, ...partial };
}

function snapshot(channels: SnapshotChannel[], roles: SnapshotRole[] = []): GuildSnapshot {
  return {
    guild: {
      id: GUILD_ID,
      name: "Test Fleet",
      description: "hello",
      icon: "abc",
      roles: [role({ id: GUILD_ID, name: "@everyone", position: 0 }), ...roles],
    },
    channels,
  };
}

describe("channel planning", () => {
  it("imports text and announcement channels, bridges only text", () => {
    const plan = buildImportPlan(
      snapshot([
        channel({ id: "1", name: "general", type: 0 }),
        channel({ id: "2", name: "news", type: 5 }),
      ]),
    );
    expect(plan.channels.map((c) => [c.name, c.bridgeable, c.bridge])).toEqual([
      ["general", true, true],
      ["news", false, false],
    ]);
  });

  it("imports voice and stage channels as -voice rooms with custom kind", () => {
    const plan = buildImportPlan(
      snapshot([
        channel({ id: "1", name: "hangout", type: 2 }),
        channel({ id: "2", name: "The Voice", type: 13 }),
      ]),
    );
    expect(plan.channels.map((c) => [c.name, c.kind])).toEqual([
      ["hangout-voice", "voice"],
      ["The Voice", "voice"], // already ends in "voice": no suffix
    ]);
  });

  it("records the category name and orders by category then position", () => {
    const plan = buildImportPlan(
      snapshot([
        channel({ id: "9", name: "Ops", type: 4, position: 1 }),
        channel({ id: "2", name: "logistics", type: 0, position: 1, parent_id: "9" }),
        channel({ id: "3", name: "briefing", type: 0, position: 0, parent_id: "9" }),
        channel({ id: "1", name: "general", type: 0, position: 0 }),
      ]),
    );
    expect(plan.channels.map((c) => [c.name, c.category])).toEqual([
      ["general", undefined],
      ["briefing", "Ops"],
      ["logistics", "Ops"],
    ]);
  });

  it("skips private channels (own overwrite) and reports them", () => {
    const plan = buildImportPlan(
      snapshot([
        channel({
          id: "1",
          name: "mods-only",
          type: 0,
          permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: (1n << 10n).toString() }],
        }),
      ]),
    );
    expect(plan.channels).toEqual([]);
    expect(plan.skipped.find((s) => s.name === "#mods-only")?.reason).toContain("private");
  });

  it("inherits privacy from the category unless the channel re-allows", () => {
    const overwrites = [{ id: GUILD_ID, type: 0, allow: "0", deny: (1n << 10n).toString() }];
    const plan = buildImportPlan(
      snapshot([
        channel({ id: "9", name: "Staff", type: 4, permission_overwrites: overwrites }),
        channel({ id: "1", name: "staff-chat", type: 0, parent_id: "9" }),
        channel({
          id: "2",
          name: "made-public",
          type: 0,
          parent_id: "9",
          permission_overwrites: [{ id: GUILD_ID, type: 0, allow: (1n << 10n).toString(), deny: "0" }],
        }),
      ]),
    );
    expect(plan.channels.map((c) => c.name)).toEqual(["made-public"]);
    expect(plan.skipped.find((s) => s.name === "#staff-chat")?.reason).toContain("private");
  });

  it("skips forum channels with a reason", () => {
    const plan = buildImportPlan(snapshot([channel({ id: "1", name: "help", type: 15 })]));
    expect(plan.channels).toEqual([]);
    expect(plan.skipped.find((s) => s.name === "#help")?.reason).toContain("forum");
  });
});

describe("role planning", () => {
  it("maps ADMINISTRATOR to ADMIN_ALL with nothing dropped", () => {
    expect(mapRolePermissions(1n << 3n)).toEqual({ permissions: ADMIN_ALL, dropped: [] });
  });

  it("maps individual bits and reports dropped Discord-only ones", () => {
    const bits = (1n << 1n) | (1n << 2n) | (1n << 13n) | (1n << 22n); // kick, ban, manage messages, mute
    const { permissions, dropped } = mapRolePermissions(bits);
    expect(permissions).toBe(Permissions.KICK | Permissions.BAN | Permissions.MANAGE_MESSAGES);
    expect(dropped).toEqual(["Mute Members"]);
  });

  it("skips @everyone, managed roles, and permissionless unhoisted roles", () => {
    const plan = buildImportPlan(
      snapshot(
        [],
        [
          role({ id: "2", name: "Some Bot", position: 3, managed: true, permissions: (1n << 3n).toString() }),
          role({ id: "3", name: "Cosmetic", position: 2 }),
          role({ id: "4", name: "Hoisted Badge", position: 1, hoist: true }),
        ],
      ),
    );
    expect(plan.roles.map((r) => r.name)).toEqual(["Hoisted Badge"]);
    expect(plan.skipped.find((s) => s.name === "Some Bot")?.reason).toContain("managed");
    expect(plan.skipped.find((s) => s.name === "Cosmetic")?.reason).toContain("no mappable");
  });

  it("preserves hierarchy: higher Discord position = lower Concord position, starting at 2", () => {
    const plan = buildImportPlan(
      snapshot(
        [],
        [
          role({ id: "2", name: "Mod", position: 1, permissions: (1n << 1n).toString() }),
          role({ id: "3", name: "Chief", position: 5, permissions: (1n << 3n).toString() }),
        ],
      ),
    );
    expect(plan.roles.map((r) => [r.name, r.position])).toEqual([
      ["Chief", 2],
      ["Mod", 3],
    ]);
  });

  it("caps imported roles at 99 and reports the overflow", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      role({ id: `r${i}`, name: `Role ${i}`, position: 200 - i, permissions: (1n << 1n).toString() }),
    );
    const plan = buildImportPlan(snapshot([], many));
    expect(plan.roles.length).toBe(MAX_IMPORTED_ROLES);
    expect(plan.skipped.filter((s) => s.reason.includes("role cap")).length).toBe(120 - MAX_IMPORTED_ROLES);
  });
});

describe("names and metadata", () => {
  it("caps names at 64 bytes without splitting code points", () => {
    expect(capName("a".repeat(80)).length).toBe(64);
    const emoji = "🚀".repeat(40); // 4 bytes each
    expect(new TextEncoder().encode(capName(emoji)).length).toBeLessThanOrEqual(64);
    expect(capName(emoji).endsWith("🚀")).toBe(true);
  });

  it("carries guild metadata and always reports unimported features", () => {
    const plan = buildImportPlan(snapshot([]));
    expect(plan.communityName).toBe("Test Fleet");
    expect(plan.guild.iconUrl).toContain("cdn.discordapp.com");
    expect(plan.skipped.some((s) => s.name === "Message history")).toBe(true);
    expect(plan.skipped.some((s) => s.name === "Members")).toBe(true);
  });
});

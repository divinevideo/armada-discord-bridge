import { describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType, ApplicationCommandType } from "discord.js";

import { parseBotCommand } from "./adapter";
import {
  SLASH_COMMANDS,
  SLASH_COMMAND_NAMES,
  interactionToCommandText,
  slashCommandRegistration,
} from "./commands";

describe("slashCommandRegistration", () => {
  const payload = slashCommandRegistration();

  it("registers both advertised commands as chat-input commands", () => {
    expect(payload.map((c) => c.name)).toEqual(["bridge", "help"]);
    for (const command of payload) {
      expect(command.type).toBe(ApplicationCommandType.ChatInput);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("maps the bridge args to required string options, with choices only on the choice arg", () => {
    const bridge = payload.find((c) => c.name === "bridge")!;
    expect(bridge.options).toHaveLength(2);
    const [action, code] = bridge.options!;
    expect(action).toMatchObject({
      name: "action",
      type: ApplicationCommandOptionType.String,
      required: true,
    });
    expect(action).toHaveProperty("choices", [{ name: "confirm", value: "confirm" }]);
    expect(code).toMatchObject({ name: "code", type: ApplicationCommandOptionType.String, required: true });
    // A free-form "string" arg carries no whitelist — only "choice" does.
    expect(code).not.toHaveProperty("choices");
  });

  it("gives help no options", () => {
    const help = payload.find((c) => c.name === "help")!;
    expect(help.options).toEqual([]);
  });

  it("exposes exactly the registered names for dispatch routing", () => {
    expect([...SLASH_COMMAND_NAMES].sort()).toEqual(["bridge", "help"]);
  });

  it("is serializable (Discord takes a JSON body)", () => {
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(SLASH_COMMANDS.every((c) => c.name === c.name.toLowerCase())).toBe(true);
  });
});

describe("interactionToCommandText", () => {
  it("rebuilds the same command token the text path parses", () => {
    const help = interactionToCommandText("help", []);
    expect(help).toBe("/help");
    expect(parseBotCommand(help)).toBe(parseBotCommand("/help"));
    expect(parseBotCommand(help)).toBe("help");
  });

  it("reconstructs /bridge confirm <code> and round-trips through parseBotCommand", () => {
    const text = interactionToCommandText("bridge", [
      { name: "action", value: "confirm" },
      { name: "code", value: "ab12cd34" },
    ]);
    expect(text).toBe("/bridge confirm ab12cd34");
    // The round-trip the text path exercised: same handler dispatch token.
    expect(parseBotCommand(text)).toBe(parseBotCommand("/bridge confirm ab12cd34"));
    expect(parseBotCommand(text)).toBe("bridge");
  });

  it("orders options by the catalog, not the order the user filled them", () => {
    // Discord lets options be typed in any order; the reconstruction stays canonical.
    const text = interactionToCommandText("bridge", [
      { name: "code", value: "ab12cd34" },
      { name: "action", value: "confirm" },
    ]);
    expect(text).toBe("/bridge confirm ab12cd34");
  });

  it("drops missing optional values rather than printing undefined", () => {
    const text = interactionToCommandText("bridge", [{ name: "action", value: "confirm" }]);
    expect(text).toBe("/bridge confirm");
    expect(text).not.toContain("undefined");
  });
});

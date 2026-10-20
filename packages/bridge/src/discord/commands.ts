/**
 * Discord application (slash) commands for the bridge bot.
 *
 * The Discord-side command surface is tiny and deliberately mirrors the kind
 * 10304 manifest the primary advertises to Armada (`BRIDGE_COMMANDS` in the
 * portal): `/help` and `/bridge confirm <code>`. Both planes name the same two
 * commands; only the wire format differs — Discord application commands here,
 * the Concord bot NIP there. The confirm action itself stays Armada-side (it is
 * gated on the Armada roster, not Discord roles), so on Discord `/bridge` is
 * discoverable but the handler still points people to Armada. See the adapter
 * for why interactions are dispatched through the same handler as typed text.
 */

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type ApplicationCommandStringOptionData,
  type ChatInputApplicationCommandData,
} from "discord.js";

/** A single command argument, in the manifest's vocabulary ("choice" | "string"). */
export interface SlashArg {
  name: string;
  description: string;
  type: "choice" | "string";
  required?: boolean;
  /** Allowed values for a "choice" arg; absent for a free-form "string". */
  choices?: string[];
}

export interface SlashCommand {
  name: string;
  description: string;
  args?: SlashArg[];
}

/**
 * The Discord command catalog. Mirrors the Armada manifest so both planes
 * advertise the same names; kept here rather than imported from the portal
 * because bridge must not depend on portal (dependency points the other way).
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "bridge",
    description: "Manage this channel's Discord bridge. /bridge confirm <code> approves a pending link.",
    args: [
      { name: "action", type: "choice", description: "What to do", required: true, choices: ["confirm"] },
      { name: "code", type: "string", description: "The 8-character confirm code", required: true },
    ],
  },
  {
    name: "help",
    description: "What this bridge bot does and which commands it answers.",
  },
];

/** Names Discord will route to us; anything else is not our command. */
export const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));

function toOption(arg: SlashArg): ApplicationCommandStringOptionData {
  // Both manifest arg kinds are Discord String options; the only difference is
  // that a "choice" arg carries an explicit whitelist. A free "string" arg is
  // not marked required unless the manifest says so.
  return {
    name: arg.name,
    description: arg.description,
    type: ApplicationCommandOptionType.String,
    required: arg.required ?? false,
    ...(arg.choices ? { choices: arg.choices.map((c) => ({ name: c, value: c })) } : {}),
  };
}

/**
 * The registration payload Discord's `application.commands.set` consumes. Pure
 * and serializable so the shape can be asserted without a gateway connection.
 */
export function slashCommandRegistration(): ChatInputApplicationCommandData[] {
  return SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    type: ApplicationCommandType.ChatInput,
    options: (command.args ?? []).map(toOption),
  }));
}

/**
 * Rebuild the equivalent text command from an interaction so it can be handed
 * to the same handler the message-text path uses. Options are emitted in the
 * catalog's declaration order — not the order the user typed them — so a slash
 * invocation reconstructs the canonical `/bridge confirm <code>` form no matter
 * how the options were filled. Only the command *name* matters for dispatch
 * (that is all `parseBotCommand` reads), but a faithful reconstruction keeps the
 * two transports byte-identical for the round-trip the text path exercised.
 */
export function interactionToCommandText(
  commandName: string,
  options: Array<{ name: string; value: string }>,
): string {
  const spec = SLASH_COMMANDS.find((c) => c.name === commandName);
  const ordered = spec?.args
    ? spec.args
        .map((a) => options.find((o) => o.name === a.name)?.value)
        .filter((v): v is string => v !== undefined)
    : options.map((o) => o.value);
  return `/${commandName}${ordered.length ? ` ${ordered.join(" ")}` : ""}`;
}

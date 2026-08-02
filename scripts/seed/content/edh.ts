/**
 * Elder Dragon Highlander (MTG Commander), scripted seed conversation.
 * Channels: deck help, deck showcase, general, introductions.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "edh",
  name: "Elder Dragon Highlander",
  invite:
    "http://localhost:8080/invite/naddr1qvzqqqyzz5pzpysnlvwx2atwx5tsk7h2525cqkz8lv8wlgax9cuxv4sfku44t55eqqqqr32uja#BAADAwQBeGuCKYxbpYzqHnaECbdVNQ",
  startedAt: "2026-07-17T19:00:00Z",
  messages: [
    { from: "marcus-a", channel: "introductions", at: 0, text: "Marcus. Commander only, casual-competitive. Dad of two, deck of ninety-nine. Pleasure to be here." },
    { from: "tibs", channel: "introductions", at: 18, text: "tibbers. budget brewer, cedh-adjacent, tcg finance goblin. i'll tell you what your deck is worth unprompted", reactions: [{ from: "dook", emoji: "😂" }] },
    { from: "pete-s", channel: "introductions", at: 40, text: "Pete, forever DM who also brews commander. my decks are 90% theme, 10% function and i'm at peace with that", reactions: [{ from: "marcus-a", emoji: "👏" }] },
    { from: "wolf", channel: "introductions", at: 65, text: "wolf. cedh grinder. i optimize everything. i promise i'm nicer than my win rate suggests", reactions: [{ from: "tibs", emoji: "🫡" }] },
    { from: "dook", channel: "introductions", at: 95, text: "sup. i goldfish decks i'll never build. it's a problem. hi", reactions: [{ from: "rai", emoji: "😂" }] },
    { from: "kai-mendez", channel: "introductions", at: 130, text: "kai, coming back to commander after a break. fighting games ate my life but the cards are calling again" },

    { from: "marcus-a", channel: "general", at: 300, text: "The eternal table question: what's your rule-zero pet peeve? Mine is people who won't say their deck's power level honestly." },
    { from: "wolf", channel: "general", at: 330, replyTo: 6, replyMode: "thread", text: "sandbagging power level. just tell me it's a 9 so i don't feel bad blowing up your board", reactions: [{ from: "tibs", emoji: "💯" }] },
    { from: "pete-s", channel: "general", at: 365, replyTo: 6, replyMode: "thread", text: "mine's the opposite, 'oh it's casual' then they combo off turn 4. own your deck!", reactions: [{ from: "dook", emoji: "😂" }, { from: "marcus-a", emoji: "💯" }] },
    { from: "tibs", channel: "general", at: 410, replyTo: 6, replyMode: "thread", text: "when someone borrows a card and it 'accidentally' ends up in their binder. we've all been robbed", reactions: [{ from: "dook", emoji: "😭" }] },
    { from: "rai", channel: "general", at: 900, text: "is it just me or is brewing the deck more fun than playing it half the time", reactions: [{ from: "pete-s", emoji: "💯" }, { from: "kai-mendez", emoji: "🙌" }] },

    { from: "kai-mendez", channel: "deck help", at: 1300, text: "coming back to a 5-year-old deck. it feels slow now. where do i even start trimming?" },
    { from: "tibs", channel: "deck help", at: 1330, replyTo: 11, replyMode: "thread", text: "cut anything 5+ mana that doesn't win or stop a win. ramp/removal/draw first, cute stuff last", reactions: [{ from: "wolf", emoji: "💯" }, { from: "kai-mendez", emoji: "🙏" }] },
    { from: "wolf", channel: "deck help", at: 1370, replyTo: 11, replyMode: "thread", text: "count your interaction. most decks run way too little. aim for 8-10 pieces minimum", reactions: [{ from: "marcus-a", emoji: "👏" }] },
    { from: "pete-s", channel: "deck help", at: 1420, replyTo: 11, replyMode: "thread", text: "counterpoint: keep ONE cute card that makes it yours. optimize the rest but leave the soul in", reactions: [{ from: "rai", emoji: "🥹" }, { from: "kai-mendez", emoji: "💜" }] },

    { from: "pete-s", channel: "deck showcase", at: 1900, text: "finished my full pirate tribute deck. not competitive, but it tells a story every game. minis on the table and everything", reactions: [{ from: "marcus-a", emoji: "🔥" }, { from: "dook", emoji: "🏴‍☠️" }, { from: "rai", emoji: "😍" }] },
    { from: "marcus-a", channel: "deck showcase", at: 1940, replyTo: 15, replyMode: "thread", text: "This is what the format is about, honestly. Function is fine; joy is the point.", reactions: [{ from: "pete-s", emoji: "💜" }] },
    { from: "tibs", channel: "deck showcase", at: 2400, text: "budget-brew flex: this whole 99 cost less than one fetchland and it beat my friend's $800 deck last night", reactions: [{ from: "dook", emoji: "🔥" }, { from: "wolf", emoji: "👏" }, { from: "kai-mendez", emoji: "😂" }] },
    { from: "wolf", channel: "deck showcase", at: 2440, replyTo: 17, replyMode: "thread", text: "budget beating bling never stops being funny. what's the wincon?" },
    { from: "tibs", channel: "deck showcase", at: 2490, replyTo: 18, replyMode: "thread", text: "aristocrats loop, all commons and uncommons. the value is genuinely disrespectful", reactions: [{ from: "wolf", emoji: "💀" }] },

    { from: "dook", channel: "general", at: 3000, text: "reminder that a bad game of commander still beats a good day at work", reactions: [{ from: "pete-s", emoji: "💯" }, { from: "marcus-a", emoji: "😂" }, { from: "rai", emoji: "🙌" }] },

    // ── content layer: deck photos, tool links; intermixed + necro-replies ──
    { id: "e-i1", from: "tibs", channel: "deck showcase", at: 900, text: "the budget brew, fully assembled. behold the jank", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Magic_the_Gathering_-_Trade.jpg/960px-Magic_the_Gathering_-_Trade.jpg" }, reactions: [{ from: "dook", emoji: "🔥" }, { from: "pete-s", emoji: "😍" }, { from: "marcus-a", emoji: "👏" }] },
    { from: "pete-s", channel: "deck showcase", at: 1400, text: "pirate deck, sleeved with the minis out. tell me it doesn't tell a story", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Magic_The_Gathering_Draft.jpg/960px-Magic_The_Gathering_Draft.jpg" }, reactions: [{ from: "marcus-a", emoji: "💜" }, { from: "rai", emoji: "😍" }] },
    { id: "e-l1", from: "tibs", channel: "deck help", at: 1800, text: "for anyone tuning: scryfall's advanced search is how i find the deep cuts nobody's running", embed: { type: "link", url: "https://scryfall.com", title: "Scryfall, MTG card search" }, reactions: [{ from: "kai-mendez", emoji: "🙏" }, { from: "wolf", emoji: "💯" }] },
    { from: "wolf", channel: "general", at: 2200, text: "edhrec is either the best brewing tool or the reason every deck looks the same. somehow both", embed: { type: "link", url: "https://edhrec.com", title: "EDHREC" }, reactions: [{ from: "tibs", emoji: "😂" }, { from: "marcus-a", emoji: "💯" }] },
    { from: "marcus-a", channel: "deck help", at: 2600, text: "Moxfield for listbuilding, cleanest tool out there. Completely changed how I tune.", embed: { type: "link", url: "https://www.moxfield.com", title: "Moxfield, deckbuilder" }, reactions: [{ from: "kai-mendez", emoji: "🙏" }, { from: "pete-s", emoji: "👍" }] },
    { from: "dook", channel: "deck showcase", at: 3200, text: "goldfished a deck i will never build (again). the curve is beautiful though", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Magic_the_Gathering_-_Judge.jpg/960px-Magic_the_Gathering_-_Judge.jpg" }, reactions: [{ from: "tibs", emoji: "😂" }, { from: "rai", emoji: "💀" }] },

    // necro-replies to older posts
    { from: "kai-mendez", channel: "deck help", at: 4500, replyTo: "e-l1", replyMode: "thread", text: "necro but this scryfall tip finally helped me trim the fat. thanks tibs", reactions: [{ from: "tibs", emoji: "🙌" }] },
    { from: "rai", channel: "deck showcase", at: 4700, replyTo: "e-i1", replyMode: "inline", text: "just saw this, budget jank supremacy. what's the commander??", reactions: [{ from: "tibs", emoji: "🔥" }] },

    // sprinkled memes (real reposts, no memes channel so #general)
    { from: "dook", channel: "general", at: 2700, text: "the only conspiracy theory i believe in", embed: { type: "image", url: "https://i.redd.it/lkrcdi5nzcgg1.png" }, reactions: [{ from: "tibs", emoji: "💯" }, { from: "wolf", emoji: "😂" }, { from: "pete-s", emoji: "😂" }] },
    { from: "tibs", channel: "general", at: 3400, text: "wotc design meetings, probably", embed: { type: "image", url: "https://i.redd.it/84kgedsy2u6g1.jpeg" }, reactions: [{ from: "dook", emoji: "💀" }, { from: "marcus-a", emoji: "😂" }, { from: "kai-mendez", emoji: "😂" }] },
    { from: "rai", channel: "general", at: 4900, text: "sadly accurate", embed: { type: "image", url: "https://i.redd.it/qwepbltuq1kg1.jpeg" }, reactions: [{ from: "pete-s", emoji: "😭" }, { from: "wolf", emoji: "💯" }] },
  ],
};

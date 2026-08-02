/**
 * Gaming, scripted seed conversation.
 * `at` is minutes from `startedAt`, increasing with array order so every reply's
 * parent is published first. Channels: animal crossing, general, introductions,
 * lfg, now playing, off topic, retro gaming.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "gaming",
  name: "Gaming",
  invite:
    "http://localhost:8080/invite/naddr1qvzqqqyzz5pzq2ztelezjn3rlk2j2hjfrvncaqcsmsc5v29ghvnkhndr6h3u75v8qqqq8pzq7t#BAADAwQBb2NXK7rkom7gm9QOCF5m9A",
  startedAt: "2026-07-18T22:00:00Z",
  messages: [
    { from: "nova", channel: "introductions", at: 0, text: "gaming server that isn't discord?? say less. i'm nova, vrchat gremlin + edm goblin. what's everyone playing rn 👀" },
    { from: "kai-mendez", channel: "introductions", at: 12, text: "kai. fighting games mostly (sf6, some tekken). also a recovering commander addict. glad this exists", reactions: [{ from: "dook", emoji: "🤝" }] },
    { from: "dan-oshea", channel: "introductions", at: 30, text: "dan. fps + lifting. two kids so my game time is 9pm-11pm sharp lol" },
    { from: "deshawn", channel: "introductions", at: 38, replyTo: 2, replyMode: "inline", text: "the dad-gamer schedule is real. 9pm gang", reactions: [{ from: "dan-oshea", emoji: "💪" }] },
    { from: "rai", channel: "introductions", at: 55, text: "hi hi im rai, 80 hrs into a jrpg i can't name without spoilers. also deckbuilders. also chiptune. also i talk too much", reactions: [{ from: "bex", emoji: "😂" }, { from: "nova", emoji: "😂" }] },
    { from: "pete-s", channel: "introductions", at: 70, text: "Pete here, forever DM, occasional video gamer when the table can't meet. i paint minis (badly)." },
    { from: "bex", channel: "introductions", at: 110, text: "bex! i mostly play cozy stuff, animal crossing is my whole personality. also i draw :)", reactions: [{ from: "nova", emoji: "💜" }] },

    { from: "milo-tran", channel: "general", at: 200, text: "ok real talk, what's the backlog situation for everyone. mine is criminal. like 40 games deep" },
    { from: "quinn", channel: "general", at: 215, replyTo: 7, replyMode: "thread", text: "40 is rookie numbers. steam says i own 300+ and have played maybe 60", reactions: [{ from: "dan-oshea", emoji: "💀" }] },
    { from: "luz", channel: "general", at: 235, replyTo: 7, replyMode: "thread", text: "backlog? i just replay the same 3 games and start something new at 2am then abandon it. adhd starter pack", reactions: [{ from: "nova", emoji: "😭" }, { from: "rai", emoji: "😭" }] },
    { from: "dook", channel: "general", at: 260, replyTo: 7, replyMode: "thread", text: "buy in sale. never install. repeat. it's a lifestyle" },
    { from: "nova", channel: "general", at: 1300, text: "unrelated my new headset arrived and the spatial audio is unreal. footsteps go crazy now", reactions: [{ from: "dan-oshea", emoji: "🔥" }] },

    { from: "dan-oshea", channel: "lfg", at: 1315, text: "anyone on for some ranked tonight? need a duo that won't rage. ~9pm est" },
    { from: "deshawn", channel: "lfg", at: 1340, replyTo: 12, replyMode: "inline", text: "i'm down. warning i talk a lot of trash but lovingly", reactions: [{ from: "dan-oshea", emoji: "😂" }] },
    { from: "rai", channel: "lfg", at: 1355, text: "looking for a co-op deckbuilder crew. slay the spire dailies? monster train? anything roguelike-ish" },
    { from: "kai-mendez", channel: "lfg", at: 1600, replyTo: 14, replyMode: "inline", text: "sts daily gang. i'll compare seeds with you any day", reactions: [{ from: "rai", emoji: "🔥" }] },

    { from: "rai", channel: "now playing", at: 1620, text: "currently: metaphor refantazio. it has eaten my life whole and i regret nothing", reactions: [{ from: "kai-mendez", emoji: "👀" }] },
    { from: "kai-mendez", channel: "now playing", at: 1645, replyTo: 16, replyMode: "thread", text: "how's the combat hold up past midgame? that's where persona-likes usually lose me" },
    { from: "rai", channel: "now playing", at: 1700, replyTo: 17, replyMode: "thread", text: "honestly holds up. the archetype swapping keeps it fresh. give it til the second dungeon", reactions: [{ from: "kai-mendez", emoji: "🙏" }] },
    { from: "nova", channel: "now playing", at: 1760, text: "phasmophobia with friends = i scream, they laugh, we lose. 10/10" },
    { from: "bex", channel: "now playing", at: 2600, text: "animal crossing (shocking). finally terraformed my whole island, send help i haven't slept", reactions: [{ from: "luz", emoji: "🥹" }] },

    { from: "quinn", channel: "retro gaming", at: 2620, text: "got a crt from a garage sale for $10 today. colors on original hardware just HIT different. no lag, no upscaling gunk", reactions: [{ from: "milo-tran", emoji: "🔥" }, { from: "kai-mendez", emoji: "😍" }] },
    { from: "milo-tran", channel: "retro gaming", at: 2645, replyTo: 21, replyMode: "thread", text: "$10?? highway robbery in your favor. what model? i've been hunting a trinitron for a year" },
    { from: "quinn", channel: "retro gaming", at: 2700, replyTo: 22, replyMode: "thread", text: "sony pvm, the good stuff. felt illegal carrying it to the car", reactions: [{ from: "milo-tran", emoji: "😭" }] },
    { from: "pete-s", channel: "retro gaming", at: 2760, text: "my kids found my old n64 and were baffled by the controller. 'why does it have three handles' broke me", reactions: [{ from: "dook", emoji: "😂" }, { from: "bex", emoji: "😂" }, { from: "nova", emoji: "💀" }] },
    { from: "kai-mendez", channel: "retro gaming", at: 3100, text: "arcade purists where you at. nothing beats a real cab and a sticky joystick", reactions: [{ from: "rai", emoji: "🕹️" }] },

    { from: "bex", channel: "animal crossing", at: 3120, text: "villager tier list incoming and it WILL be controversial. raymond is overrated, i said what i said", reactions: [{ from: "nova", emoji: "👀" }] },
    { from: "nova", channel: "animal crossing", at: 3150, replyTo: 26, replyMode: "inline", text: "absolutely not. raymond supremacy. we fight now 🥊", reactions: [{ from: "bex", emoji: "😤" }] },
    { from: "luz", channel: "animal crossing", at: 3600, replyTo: 26, replyMode: "thread", text: "the real endgame is the villagers nobody wants. i'd die for my weird ones", reactions: [{ from: "bex", emoji: "💜" }] },

    { from: "dook", channel: "off topic", at: 3620, text: "controversial: cereal is a soup. discuss", reactions: [{ from: "nova", emoji: "💀" }, { from: "kai-mendez", emoji: "😂" }] },
    { from: "deshawn", channel: "off topic", at: 3700, replyTo: 29, replyMode: "inline", text: "this is the exact unhinged energy i left discord for. missed you people" },
    { from: "milo-tran", channel: "off topic", at: 4000, text: "spent my sunday cable-managing my battlestation instead of actually gaming. peak gamer paradox", reactions: [{ from: "quinn", emoji: "😂" }, { from: "dan-oshea", emoji: "🔥" }] },
    { from: "tibs", channel: "off topic", at: 4040, text: "anyone else's 'quick game before bed' become 2am on the regular or is that just me", reactions: [{ from: "luz", emoji: "🙋" }, { from: "nova", emoji: "🙋" }, { from: "rai", emoji: "🙋" }] },

    // ── content layer: clips, memes, links; intermixed + necro-replies ──
    { from: "tomo", channel: "introductions", at: 90, text: "tomo. i clip everything. if it was cool, i have a video of it. nice to meet you all", reactions: [{ from: "nova", emoji: "👋" }] },
    { from: "goose", channel: "introductions", at: 140, text: "honk. i post memes. that's the bio.", reactions: [{ from: "dook", emoji: "🐐" }, { from: "bex", emoji: "😂" }] },

    { id: "gm-v1", from: "tomo", channel: "now playing", at: 1500, text: "the witcher 3 killing monsters cinematic STILL goes so hard. rewatched it for the 100th time", embed: { type: "video", url: "https://www.youtube.com/watch?v=c0i88t0Kacs", title: "The Witcher 3, Killing Monsters Cinematic" }, reactions: [{ from: "kai-mendez", emoji: "🔥" }, { from: "rai", emoji: "😍" }, { from: "dook", emoji: "🔥" }] },
    { id: "gm-m1", from: "goose", channel: "off topic", at: 1700, text: "my backlog, accurately", embed: { type: "image", url: "https://i.imgflip.com/2fm6x.jpg" }, reactions: [{ from: "quinn", emoji: "💀" }, { from: "dan-oshea", emoji: "😂" }, { from: "nova", emoji: "💀" }] },

    { id: "gm-l1", from: "milo-tran", channel: "general", at: 2200, text: "steam sale is live and my wallet is officially scared", embed: { type: "link", url: "https://store.steampowered.com", title: "Steam" }, reactions: [{ from: "dook", emoji: "💀" }, { from: "deshawn", emoji: "😂" }, { from: "rai", emoji: "🙌" }] },
    { from: "tomo", channel: "now playing", at: 2600, text: "reinstalling skyrim for the 9th time. it's a documented illness at this point", embed: { type: "video", url: "https://www.youtube.com/watch?v=JSRtYpNRoN0", title: "The Elder Scrolls V: Skyrim, Official Trailer" }, reactions: [{ from: "quinn", emoji: "😂" }, { from: "kai-mendez", emoji: "🤝" }] },
    { from: "goose", channel: "off topic", at: 3000, text: "fell down the original keyboard cat rabbit hole. send help", embed: { type: "video", url: "https://www.youtube.com/watch?v=J---aiyznGQ", title: "Keyboard Cat! - THE ORIGINAL!" }, reactions: [{ from: "bex", emoji: "😹" }, { from: "nova", emoji: "😹" }] },

    { from: "deshawn", channel: "general", at: 4000, text: "for the linux gamers: protondb basically saved my whole library, check your games before you rage", embed: { type: "link", url: "https://www.protondb.com", title: "ProtonDB" }, reactions: [{ from: "quinn", emoji: "🙏" }, { from: "milo-tran", emoji: "💯" }] },

    // necro-replies to older posts
    { from: "rai", channel: "now playing", at: 5500, replyTo: "gm-v1", replyMode: "inline", text: "just saw this, adding witcher 3 to the replay pile immediately. no regrets", reactions: [{ from: "tomo", emoji: "🙌" }] },
    { from: "quinn", channel: "general", at: 5600, replyTo: "gm-l1", replyMode: "thread", text: "necro but i caved during that sale and bought 6 games i'll never install. classic", reactions: [{ from: "milo-tran", emoji: "😂" }, { from: "dook", emoji: "💀" }] },

    // sprinkled memes (real reposts)
    { from: "goose", channel: "off topic", at: 2900, text: "me still today", embed: { type: "image", url: "https://i.redd.it/ddw9k238n76h1.jpeg" }, reactions: [{ from: "milo-tran", emoji: "😂" }, { from: "rai", emoji: "💀" }] },
    { from: "dook", channel: "off topic", at: 4300, text: "a guide to actually enjoying your games", embed: { type: "image", url: "https://i.redd.it/3276m32fc5rf1.jpeg" }, reactions: [{ from: "quinn", emoji: "💯" }, { from: "deshawn", emoji: "😂" }, { from: "nova", emoji: "😂" }] },
  ],
};

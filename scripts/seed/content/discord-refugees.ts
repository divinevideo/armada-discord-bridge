/**
 * Discord Refugees, scripted seed conversation.
 *
 * `at` is minutes from `startedAt`, kept increasing with array order so every
 * reply's parent is always published before it. Mix of top-level posts, inline
 * replies (q), threaded replies (kind 1111), and reactions. Personas are the
 * global roster members whose `communities` include "discord-refugees".
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "discord-refugees",
  name: "Discord Refugees",
  invite:
    "http://localhost:8080/invite/naddr1qvzqqqyzz5pzqj708td9fc9s3vlfxurq58ztev69fqvs0pm2mglscmekwm5pmc2mqqqqs75sae#BAADAwQB8zkvJkcZL2wk9-OB3CR0hw",
  startedAt: "2026-07-20T15:00:00Z",
  messages: [
    // ── introductions ──────────────────────────────────────────────
    {
      from: "gordo",
      channel: "introductions",
      at: 0,
      text: "well hello. found this place through a mastodon post... first new forum i've joined since my old vbulletin board went dark. be gentle.",
    },
    {
      from: "milo-tran",
      channel: "introductions",
      at: 25,
      text: "welcome gordo! i'm milo, ex-discord mod. ran a 4k member server for years til the api changes killed all my bots. glad to be somewhere that isn't trying to sell me nitro",
      reactions: [{ from: "bex", emoji: "👋" }, { from: "priya-sundaram", emoji: "👋" }],
    },
    {
      from: "priya-sundaram",
      channel: "introductions",
      at: 55,
      text: "Hi all! Priya here, backend dev by day, slowly training for a marathon. Left after one too many outages during raid night. 👋",
    },
    {
      from: "bex",
      channel: "introductions",
      at: 90,
      text: "hi hi im bex i draw little guys :) mostly here bc my whole art server got nuked with no warning. still salty",
      reactions: [{ from: "milo-tran", emoji: "💜" }, { from: "yuki", emoji: "🫂" }],
    },
    {
      from: "dook",
      channel: "introductions",
      at: 130,
      text: "sup. got banned from 3 servers for 'excessive frog emojis'. no regrets",
      reactions: [{ from: "nova", emoji: "🐸" }, { from: "dan-oshea", emoji: "🐸" }, { from: "sasha-v", emoji: "🐸" }],
    },
    {
      from: "milo-tran",
      channel: "introductions",
      at: 140,
      replyTo: 4,
      replyMode: "inline",
      text: "this is the most valid reason i've ever heard",
    },
    {
      from: "ren-okafor",
      channel: "introductions",
      at: 200,
      text: "ren. i self-host everything i can. degoogled phone, homelab, the works. discord was the last big thing i couldn't replace. watching this closely.",
    },
    {
      from: "omar-k",
      channel: "introductions",
      at: 230,
      replyTo: 6,
      replyMode: "inline",
      text: "same boat honestly. 'the last big thing i couldn't replace' is such a real way to put it",
    },
    {
      from: "hana-lee",
      channel: "introductions",
      at: 300,
      text: "Hello everyone, I'm Hana. I cook a lot and take film photos. Found this through a friend who left over the privacy stuff. Happy to be here.",
      reactions: [{ from: "priya-sundaram", emoji: "😊" }],
    },

    // ── general (a thread on WHY people left) ───────────────────────
    {
      from: "nova",
      channel: "general",
      at: 500,
      text: "ok but is anyone else's brain still wired to alt-tab to discord every 5 min. the muscle memory is REAL 😭",
      reactions: [{ from: "bex", emoji: "😭" }, { from: "dook", emoji: "😭" }, { from: "milo-tran", emoji: "😭" }],
    },
    { from: "dan-oshea", channel: "general", at: 515, replyTo: 9, replyMode: "inline", text: "every. single. day." },
    {
      from: "theo-m",
      channel: "general",
      at: 540,
      text: "took me a week to stop. now i just alt-tab to nothing and stare at my desktop",
      reactions: [{ from: "nova", emoji: "💀" }],
    },
    {
      from: "sasha-v",
      channel: "general",
      at: 600,
      text: "the freedom of not being watched by a company that logs literally everything is worth the retraining!!! ride or die for this",
    },
    {
      from: "marcus-a",
      channel: "general",
      at: 900,
      text: "Genuine question for the room: what actually made you leave? Not the last straw, the real reason underneath.",
    },
    {
      from: "gordo",
      channel: "general",
      at: 930,
      replyTo: 13,
      replyMode: "thread",
      text: "for me it was watching a place i'd spent a decade in become an ad. slowly, then all at once. the soul left before i did...",
      reactions: [{ from: "hana-lee", emoji: "🫂" }, { from: "omar-k", emoji: "💯" }],
    },
    {
      from: "priya-sundaram",
      channel: "general",
      at: 960,
      replyTo: 13,
      replyMode: "thread",
      text: "Mine was practical at first, the outages. But then I read what they actually collect and couldn't unsee it.",
    },
    {
      from: "ren-okafor",
      channel: "general",
      at: 1000,
      replyTo: 13,
      replyMode: "thread",
      text: "ownership. i don't own anything there. my server, my members, my messages, all rented. one tos change and it's gone.",
      reactions: [{ from: "sasha-v", emoji: "💯" }, { from: "marcus-a", emoji: "👏" }],
    },
    { from: "marcus-a", channel: "general", at: 1030, replyTo: 16, replyMode: "thread", text: "That's the clearest version of it. Thank you." },

    // ── migration help (a thread) ───────────────────────────────────
    {
      from: "bex",
      channel: "migration help",
      at: 1300,
      text: "dumb question but how do i even get my old server members to come here? like do i just... post the link and pray?",
    },
    {
      from: "milo-tran",
      channel: "migration help",
      at: 1330,
      replyTo: 18,
      replyMode: "thread",
      text: "not dumb at all. what worked for me: pinned the invite in the old server, gave it two weeks, posted a couple reminders. ~30% came over which honestly beat my expectations",
      reactions: [{ from: "bex", emoji: "🙏" }],
    },
    {
      from: "priya-sundaram",
      channel: "migration help",
      at: 1360,
      replyTo: 18,
      replyMode: "thread",
      text: "Also seed it first! An empty server scares people off. Get a few channels active before you invite the crowd.",
      reactions: [{ from: "milo-tran", emoji: "💯" }, { from: "omar-k", emoji: "✅" }],
    },
    { from: "bex", channel: "migration help", at: 1400, replyTo: 20, replyMode: "thread", text: "oh that's smart. ok gonna set up channels first then. ty ty 🙏" },
    {
      from: "quinn",
      channel: "migration help",
      at: 1600,
      text: "for archiving old messages i used a self-hosted exporter before i left. happy to share the setup if anyone wants their history out before a ban wipes it",
      reactions: [{ from: "ren-okafor", emoji: "👀" }, { from: "gordo", emoji: "🙏" }],
    },

    // ── privacy tips (a thread) ─────────────────────────────────────
    {
      from: "ren-okafor",
      channel: "privacy tips",
      at: 1900,
      text: "starter pack for anyone just landing: 1) a different password per account (use a manager) 2) 2fa on everything, ideally a hardware key 3) stop using sms for 2fa. that's 90% of the win right there",
      reactions: [{ from: "priya-sundaram", emoji: "📌" }, { from: "omar-k", emoji: "📌" }, { from: "hana-lee", emoji: "🙏" }, { from: "sasha-v", emoji: "🔥" }],
    },
    { from: "sasha-v", channel: "privacy tips", at: 1930, replyTo: 23, replyMode: "thread", text: "hardware keys changed my life. yubikey gang!!!" },
    { from: "priya-sundaram", channel: "privacy tips", at: 1960, replyTo: 23, replyMode: "thread", text: "Would add: check haveibeenpwned for your emails. Sobering but useful." },
    {
      from: "gordo",
      channel: "privacy tips",
      at: 2000,
      replyTo: 23,
      replyMode: "thread",
      text: "back in my day we just... didn't put anything real online. wild concept now, i know",
      reactions: [{ from: "dook", emoji: "😂" }, { from: "nova", emoji: "😂" }],
    },

    // ── alternatives (inline + thread mix) ──────────────────────────
    { from: "dook", channel: "alternatives", at: 2300, text: "so what's everyone actually using now. matrix? this? signal for the small stuff?" },
    {
      from: "theo-m",
      channel: "alternatives",
      at: 2330,
      replyTo: 27,
      replyMode: "inline",
      text: "signal for close friends, this for community. matrix i tried but the ux fought me the whole time",
      reactions: [{ from: "milo-tran", emoji: "💯" }],
    },
    {
      from: "milo-tran",
      channel: "alternatives",
      at: 2360,
      replyTo: 27,
      replyMode: "thread",
      text: "i bounced off matrix too. federation is cool in theory but explaining homeservers to my non-techy members was a nonstarter",
    },
    {
      from: "ren-okafor",
      channel: "alternatives",
      at: 2400,
      replyTo: 29,
      replyMode: "thread",
      text: "the homeserver question is the whole problem in one line. normal people don't want to pick a server, they want to talk to their friends",
      reactions: [{ from: "priya-sundaram", emoji: "💯" }, { from: "marcus-a", emoji: "👏" }],
    },
    {
      from: "nova",
      channel: "alternatives",
      at: 2500,
      text: "honestly whatever my friends are on i'll be on. that's the whole thing. the tech matters less than the people 🤷‍♀️",
      reactions: [{ from: "hana-lee", emoji: "💯" }, { from: "dan-oshea", emoji: "🔥" }],
    },

    // ── nostr101 (a thread) ─────────────────────────────────────────
    { from: "hana-lee", channel: "nostr101", at: 2800, text: "Okay I keep seeing 'nostr' and 'npub' everywhere. Can someone explain like I'm five? What even is it?" },
    {
      from: "ren-okafor",
      channel: "nostr101",
      at: 2840,
      replyTo: 32,
      replyMode: "thread",
      text: "short version: it's a protocol, not an app. your identity is a keypair you own, not an account a company gives you. you can move between apps and keep your followers, posts, everything",
      reactions: [{ from: "hana-lee", emoji: "🤯" }, { from: "priya-sundaram", emoji: "📌" }],
    },
    {
      from: "milo-tran",
      channel: "nostr101",
      at: 2880,
      replyTo: 32,
      replyMode: "thread",
      text: "the 'you own your identity' part is the magic. no one can deplatform you because there's no central platform to ban you from. worst case you just switch apps",
      reactions: [{ from: "sasha-v", emoji: "🔥" }, { from: "gordo", emoji: "👏" }],
    },
    { from: "hana-lee", channel: "nostr101", at: 2920, replyTo: 34, replyMode: "thread", text: "okay THAT clicks. so the ban stories in this server basically can't happen here?" },
    {
      from: "ren-okafor",
      channel: "nostr101",
      at: 2960,
      replyTo: 35,
      replyMode: "thread",
      text: "not by a company, no. a community can still moderate itself, which is different and good. the difference is who holds the power",
      reactions: [{ from: "omar-k", emoji: "💯" }, { from: "marcus-a", emoji: "💯" }],
    },

    // ── off topic ───────────────────────────────────────────────────
    {
      from: "milo-tran",
      channel: "off topic",
      at: 3200,
      text: "unrelated but i just finished a new keyboard build and she's GORGEOUS. holy tactile. anyway carry on",
      reactions: [{ from: "quinn", emoji: "😍" }, { from: "theo-m", emoji: "👀" }],
    },
    { from: "quinn", channel: "off topic", at: 3220, replyTo: 37, replyMode: "inline", text: "switches?? specs?? don't leave us hanging" },
    {
      from: "milo-tran",
      channel: "off topic",
      at: 3250,
      replyTo: 38,
      replyMode: "thread",
      text: "boba u4t (silent tactile), gmk clone caps, tofu65 case. typing on it feels illegal",
      reactions: [{ from: "quinn", emoji: "🔥" }, { from: "dook", emoji: "👏" }],
    },
    {
      from: "theo-m",
      channel: "off topic",
      at: 3400,
      text: "meanwhile i've spent the week trying to mix one track and my ears are fried. anyone else lose all objectivity after hour 3",
      reactions: [{ from: "nova", emoji: "😭" }],
    },
    { from: "bex", channel: "off topic", at: 3430, replyTo: 40, replyMode: "inline", text: "every time!! i have to sleep on art or i hate all of it" },
    {
      from: "yuki",
      channel: "off topic",
      at: 3600,
      text: "made cinnamon rolls today and forgot to photograph them before they were gone. you'll just have to trust me they were perfect 🌀",
      reactions: [{ from: "hana-lee", emoji: "😍" }, { from: "omar-k", emoji: "😋" }, { from: "dan-oshea", emoji: "😩" }],
    },

    // ── snark ───────────────────────────────────────────────────────
    {
      from: "dook",
      channel: "snark",
      at: 3900,
      text: "discord: 'we've heard your feedback' *ships a new emoji cosmetics store*",
      reactions: [{ from: "nova", emoji: "💀" }, { from: "milo-tran", emoji: "😂" }, { from: "sasha-v", emoji: "😂" }, { from: "gordo", emoji: "😂" }],
    },
    {
      from: "nova",
      channel: "snark",
      at: 3930,
      replyTo: 43,
      replyMode: "inline",
      text: "not the $10 animated avatar border while search still doesn't work 💀",
      reactions: [{ from: "dook", emoji: "💀" }],
    },
    {
      from: "gordo",
      channel: "snark",
      at: 4000,
      text: "remember when software just... did the thing. no store. no battle pass. a man can dream",
      reactions: [{ from: "marcus-a", emoji: "🫡" }],
    },
    { from: "marcus-a", channel: "snark", at: 4030, replyTo: 45, replyMode: "inline", text: "The ✨monetization✨ of the group chat is a special kind of dystopia." },

    // ── banned ──────────────────────────────────────────────────────
    { from: "dook", channel: "banned", at: 4300, text: "starting the hall of fame: banned for 'frog spam' (accurate). who's topping that" },
    {
      from: "sasha-v",
      channel: "banned",
      at: 4330,
      replyTo: 47,
      replyMode: "thread",
      text: "banned from a server for asking why they didn't have an encrypted option for org work lol. asked the wrong question apparently",
      reactions: [{ from: "ren-okafor", emoji: "🫡" }, { from: "milo-tran", emoji: "👀" }],
    },
    {
      from: "bex",
      channel: "banned",
      at: 4360,
      replyTo: 47,
      replyMode: "thread",
      text: "my whole SERVER got deleted, not even a ban. 2 years of art and inside jokes just gone. still not over it",
      reactions: [{ from: "hana-lee", emoji: "🫂" }, { from: "yuki", emoji: "🫂" }, { from: "omar-k", emoji: "🫂" }, { from: "priya-sundaram", emoji: "💔" }],
    },
    {
      from: "omar-k",
      channel: "banned",
      at: 4400,
      replyTo: 49,
      replyMode: "thread",
      text: "that's genuinely a grief thing, bex. a place with that many memories vanishing is a real loss. sorry you went through it",
      reactions: [{ from: "bex", emoji: "🫂" }, { from: "hana-lee", emoji: "💜" }],
    },

    // ── armada (meta) ───────────────────────────────────────────────
    {
      from: "priya-sundaram",
      channel: "armada",
      at: 4700,
      text: "Been poking at Armada's guts a bit. The fact that the community keys are yours, not sitting on a server the company controls, is... actually the thing I wanted this whole time.",
      reactions: [{ from: "ren-okafor", emoji: "💯" }, { from: "milo-tran", emoji: "🔥" }],
    },
    {
      from: "ren-okafor",
      channel: "armada",
      at: 4740,
      replyTo: 51,
      replyMode: "thread",
      text: "e2e encrypted AND no host to subpoena. that combo is why i'm actually paying attention to this one and not the last five 'discord killers'",
      reactions: [{ from: "sasha-v", emoji: "🔥" }, { from: "marcus-a", emoji: "💯" }],
    },
    {
      from: "milo-tran",
      channel: "armada",
      at: 4780,
      text: "the invite-link-is-the-key thing tripped me up at first but once it clicked it's elegant. no accounts to approve, you either have the link or you don't",
      reactions: [{ from: "priya-sundaram", emoji: "💯" }],
    },

    // ── general (wrap) ──────────────────────────────────────────────
    {
      from: "omar-k",
      channel: "general",
      at: 5200,
      text: "this place already feels more like a community than my last server did in a year. funny how removing the slot-machine mechanics does that",
      reactions: [{ from: "milo-tran", emoji: "💯" }, { from: "hana-lee", emoji: "💜" }, { from: "gordo", emoji: "👏" }, { from: "nova", emoji: "🥹" }, { from: "dan-oshea", emoji: "🔥" }],
    },

    // ── content layer: links, memes, videos, news; intermixed + necro-replies ──
    { from: "juno", channel: "introductions", at: 220, text: "juno here! adhd, 47 tabs open. i'll be the one dropping articles nobody asked for 🙃", reactions: [{ from: "omar-k", emoji: "👋" }, { from: "milo-tran", emoji: "👋" }] },
    { from: "vic-osei", channel: "introductions", at: 250, text: "vic. i hoard rss feeds so you don't have to. expect links in #general 📰", reactions: [{ from: "priya-sundaram", emoji: "👋" }, { from: "gordo", emoji: "👋" }] },

    { id: "dr-news1", from: "vic-osei", channel: "general", at: 1500, text: "company quietly expanded what they collect. again. this is the treadmill we all stepped off.", embed: { type: "link", url: "https://www.eff.org/deeplinks", title: "EFF Deeplinks, privacy & surveillance news" }, reactions: [{ from: "ren-okafor", emoji: "😤" }, { from: "sasha-v", emoji: "😤" }, { from: "priya-sundaram", emoji: "📌" }] },
    { from: "ren-okafor", channel: "general", at: 1540, replyTo: "dr-news1", replyMode: "thread", text: "and we were the paranoid ones. right.", reactions: [{ from: "vic-osei", emoji: "💯" }] },

    { id: "dr-meme1", from: "goose", channel: "off topic", at: 1800, text: "the alt-tab-to-discord muscle memory, colorized", embed: { type: "image", url: "https://i.imgflip.com/gk5el.jpg" }, reactions: [{ from: "nova", emoji: "💀" }, { from: "dook", emoji: "💀" }, { from: "milo-tran", emoji: "😂" }] },

    { id: "dr-vid1", from: "milo-tran", channel: "nostr101", at: 3000, text: "best short nostr explainer i've found for non-tech folks. worth a few minutes", embed: { type: "video", url: "https://www.youtube.com/watch?v=NVm_jGdwTjQ", title: "What is Nostr? (explainer)" }, reactions: [{ from: "hana-lee", emoji: "🙏" }, { from: "priya-sundaram", emoji: "👀" }] },

    { from: "goose", channel: "snark", at: 3950, text: "discord's 2026 roadmap [leaked]", embed: { type: "image", url: "https://i.imgflip.com/wxica.jpg" }, reactions: [{ from: "dook", emoji: "💀" }, { from: "gordo", emoji: "😂" }, { from: "nova", emoji: "💀" }] },

    { id: "dr-news2", from: "juno", channel: "general", at: 4200, text: "good piece on why leaving an online community is so hard. it named something for me", embed: { type: "link", url: "https://dallincrump.com/leaving-an-online-community-for-the-sake-of-mental-health", title: "Leaving an Online Community for the Sake of Mental Health" }, reactions: [{ from: "bex", emoji: "🫂" }, { from: "gordo", emoji: "💯" }, { from: "omar-k", emoji: "💜" }] },
    { from: "bex", channel: "general", at: 4260, replyTo: "dr-news2", replyMode: "inline", text: "this is my whole deleted-server feelings in one article. oof", reactions: [{ from: "juno", emoji: "🫂" }] },

    { id: "dr-vid2", from: "dook", channel: "off topic", at: 5000, text: "found the original keyboard cat and it fixed my entire mood. undefeated", embed: { type: "video", url: "https://www.youtube.com/watch?v=J---aiyznGQ", title: "Keyboard Cat! - THE ORIGINAL!" }, reactions: [{ from: "milo-tran", emoji: "😂" }, { from: "nova", emoji: "😹" }, { from: "bex", emoji: "😹" }] },

    // necro-replies: people replying days later to older posts they just saw
    { from: "vic-osei", channel: "privacy tips", at: 6000, replyTo: 23, replyMode: "thread", text: "necro'ing ren's pinned list, a solid rundown on why sms 2fa is the weak link", embed: { type: "link", url: "https://www.privacyguides.org/en/basics/multi-factor-authentication/", title: "Multi-Factor Authentication - Privacy Guides" }, reactions: [{ from: "ren-okafor", emoji: "💯" }, { from: "priya-sundaram", emoji: "📌" }] },
    { from: "omar-k", channel: "nostr101", at: 6100, replyTo: 32, replyMode: "thread", text: "late to this thread but the 'you own your identity' point finally made nostr click for me too", reactions: [{ from: "hana-lee", emoji: "💜" }, { from: "ren-okafor", emoji: "💯" }] },
    { from: "gordo", channel: "off topic", at: 6500, replyTo: "dr-vid2", replyMode: "inline", text: "beautiful chaos... reminds me of my ferret circa 2003", reactions: [{ from: "dook", emoji: "😂" }] },

    // sprinkled memes (real reposts)
    { from: "priya-sundaram", channel: "snark", at: 4150, text: "posting this here because the work slack would fire me", embed: { type: "image", url: "https://i.redd.it/23k41gf1jx4h1.jpeg" }, reactions: [{ from: "ren-okafor", emoji: "💀" }, { from: "milo-tran", emoji: "😂" }, { from: "dook", emoji: "😂" }] },
    { from: "goose", channel: "off topic", at: 5600, text: "well well well", embed: { type: "image", url: "https://i.redd.it/ns657gyltxpf1.png" }, reactions: [{ from: "dook", emoji: "💀" }, { from: "nova", emoji: "😂" }] },
  ],
};

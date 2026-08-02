/**
 * Nuerodivergents Convergence, scripted seed conversation. A supportive space;
 * dialogue is warm and authentic, not clinical.
 * Channels: ADHD, audhd women, autism, body-doubling, general, hyperfixations,
 * introductions, questions and advice, resources, vent.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "neurodivergents",
  name: "Nuerodivergents Convergence",
  invite:
    "http://localhost:8080/invite/naddr1qvzqqqyzz5pzqujgprkjnz5hd4xy2c5ey5v77jq57fmegt5rvfsdl87musg9rg9dqqqq9mxqwa#BAADAwQBWfDktfdzemLckL_vzMF-zg",
  startedAt: "2026-07-16T14:00:00Z",
  messages: [
    { from: "omar-k", channel: "introductions", at: 0, text: "Omar here. therapist-in-training, late-diagnosed adhd, girl-dad. this kind of space matters to me a lot. glad you're all here." },
    { from: "cora", channel: "introductions", at: 15, text: "hi, cora. autistic, ceramicist, professional tea-hoarder. i already mask less here than most places and i just arrived", reactions: [{ from: "omar-k", emoji: "💜" }, { from: "fern", emoji: "🫂" }] },
    { from: "ren-okafor", channel: "introductions", at: 35, text: "ren. autistic + adhd. i cope by building systems for everything. the homelab is basically an external brain", reactions: [{ from: "wolf", emoji: "💯" }] },
    { from: "luz", channel: "introductions", at: 60, text: "luz!! adhd's strongest soldier, currently ignoring 4 unfinished projects to write this. hi 👋", reactions: [{ from: "nova", emoji: "😭" }, { from: "sasha-v", emoji: "🙌" }] },
    { from: "mika", channel: "introductions", at: 85, text: "mika, they/them. autistic, sensory-seeker, i stim with sound. gentle space appreciated 🌿", reactions: [{ from: "cora", emoji: "💚" }] },
    { from: "nova", channel: "introductions", at: 110, text: "nova, audhd and chaotic. i will infodump at the slightest provocation. consider yourselves warned 💅", reactions: [{ from: "luz", emoji: "😂" }] },

    { from: "omar-k", channel: "general", at: 300, text: "gentle check-in: how's everyone's spoons today? no pressure to elaborate, a number or an emoji is enough" },
    { from: "sasha-v", channel: "general", at: 330, replyTo: 6, replyMode: "thread", text: "running on fumes but the good kind. hyperfocus cleaned my whole apartment at 3am!!!", reactions: [{ from: "luz", emoji: "🙌" }] },
    { from: "cora", channel: "general", at: 360, replyTo: 6, replyMode: "thread", text: "maybe a 4. slow morning, lots of tea, one thing at a time.", reactions: [{ from: "omar-k", emoji: "🫂" }] },
    { from: "wolf", channel: "general", at: 400, replyTo: 6, replyMode: "thread", text: "a 2, but i showed up, which for me counts as a 6", reactions: [{ from: "omar-k", emoji: "💯" }, { from: "mika", emoji: "💜" }] },
    { from: "ren-okafor", channel: "general", at: 460, text: "small win: built a reminder system that works WITH my brain instead of against it. object permanence via sticky notes everywhere", reactions: [{ from: "luz", emoji: "💯" }] },

    { from: "luz", channel: "body-doubling", at: 900, text: "starting a focus session in 10 min, anyone want to body-double? i'll be doing taxes 😩 misery loves company", reactions: [{ from: "nova", emoji: "🙋" }, { from: "cora", emoji: "🙋" }] },
    { from: "cora", channel: "body-doubling", at: 930, replyTo: 11, replyMode: "inline", text: "in. i'll glaze pots while you suffer through taxes. solidarity", reactions: [{ from: "luz", emoji: "😂" }] },
    { from: "nova", channel: "body-doubling", at: 960, replyTo: 11, replyMode: "inline", text: "joining! i work SO much better knowing someone else is also Doing A Thing", reactions: [{ from: "luz", emoji: "💜" }] },
    { from: "mika", channel: "body-doubling", at: 1000, text: "the fact that just knowing someone else is working makes my brain cooperate will never not be funny to me", reactions: [{ from: "ren-okafor", emoji: "💯" }] },

    { from: "nova", channel: "hyperfixations", at: 1300, text: "current hyperfixation: the entire history of a niche rhythm game nobody's heard of. ask me anything, please, i'm begging", reactions: [{ from: "luz", emoji: "😂" }] },
    { from: "ren-okafor", channel: "hyperfixations", at: 1330, replyTo: 15, replyMode: "thread", text: "this is the correct use of the channel. mine's currently arm assembly for no practical reason", reactions: [{ from: "wolf", emoji: "🔥" }] },
    { from: "fern", channel: "hyperfixations", at: 1360, text: "mine is moss. specifically which mosses grow on which trees. i have Notes. so many notes 🌱", reactions: [{ from: "mika", emoji: "💚" }, { from: "cora", emoji: "😍" }] },
    { from: "cora", channel: "hyperfixations", at: 1400, replyTo: 17, replyMode: "thread", text: "please share the notes. i want to know about the moss. i mean this completely sincerely", reactions: [{ from: "fern", emoji: "🥹" }] },

    { from: "cora", channel: "autism", at: 1700, text: "unmasking in small doses is so strange. like remembering you have a face under a mask you forgot you were wearing", reactions: [{ from: "mika", emoji: "💯" }, { from: "ren-okafor", emoji: "💯" }] },
    { from: "mika", channel: "autism", at: 1740, replyTo: 19, replyMode: "thread", text: "yes. and the exhaustion after masking all day is a real, physical thing. rest is not optional", reactions: [{ from: "omar-k", emoji: "💜" }] },

    { from: "luz", channel: "ADHD", at: 2100, text: "the adhd tax is real. renewed a subscription i forgot to cancel AGAIN. rip $60", reactions: [{ from: "nova", emoji: "😭" }, { from: "sasha-v", emoji: "😭" }] },
    { from: "omar-k", channel: "ADHD", at: 2140, replyTo: 21, replyMode: "thread", text: "self-compassion reminder: your brain isn't broken, the system assumes a brain you don't have. cancel it and forgive yourself", reactions: [{ from: "luz", emoji: "🫂" }, { from: "nova", emoji: "💜" }] },

    { from: "cora", channel: "audhd women", at: 2500, text: "the late-diagnosis grief hits different as a woman. all those years of 'you're just so sensitive' when it was this the whole time", reactions: [{ from: "nova", emoji: "💯" }, { from: "sasha-v", emoji: "🫂" }] },
    { from: "nova", channel: "audhd women", at: 2540, replyTo: 23, replyMode: "thread", text: "reframing my entire childhood after diagnosis was A Journey. mourning and relief at the same time", reactions: [{ from: "cora", emoji: "💜" }] },

    { from: "sasha-v", channel: "questions and advice", at: 2900, text: "how do you all handle rejection sensitivity? mine is brutal and i'm tired of one small comment ruining my whole day" },
    { from: "omar-k", channel: "questions and advice", at: 2940, replyTo: 25, replyMode: "thread", text: "naming it in the moment helps me, 'this is RSD, not reality'. doesn't fix it but it opens a gap to breathe in", reactions: [{ from: "sasha-v", emoji: "🙏" }, { from: "cora", emoji: "💯" }] },
    { from: "wolf", channel: "questions and advice", at: 2980, replyTo: 25, replyMode: "thread", text: "i keep a note that says 'you are catastrophizing, wait 24h'. re-read it every time. usually right", reactions: [{ from: "sasha-v", emoji: "💜" }] },

    { from: "ren-okafor", channel: "resources", at: 3300, text: "will drop a link to a free adhd-friendly task app that doesn't guilt-trip you. no streaks, no shame. changed my week", reactions: [{ from: "luz", emoji: "🙏" }, { from: "omar-k", emoji: "📌" }] },
    { from: "omar-k", channel: "resources", at: 3360, text: "gentle reminder: a therapist who specializes in neurodivergence is worth seeking out. someone who gets it changes everything", reactions: [{ from: "cora", emoji: "💯" }, { from: "mika", emoji: "💜" }] },

    { from: "sasha-v", channel: "vent", at: 3700, text: "just need to say it: today was hard and i did it anyway. that's the whole vent.", reactions: [{ from: "omar-k", emoji: "🫂" }, { from: "cora", emoji: "🫂" }, { from: "luz", emoji: "💜" }, { from: "mika", emoji: "💚" }, { from: "nova", emoji: "🥹" }] },

    // ── content layer: resources, articles, hyperfixation photos; necro-replies ──
    { from: "juno", channel: "introductions", at: 90, text: "juno! adhd, 47 tabs open. i'll be the one dropping the good articles from 46 of them 🙃", reactions: [{ from: "omar-k", emoji: "👋" }, { from: "cora", emoji: "💜" }] },
    { from: "vic-osei", channel: "introductions", at: 130, text: "vic. i share links and i lurk. working on the lurking part.", reactions: [{ from: "ren-okafor", emoji: "👋" }] },
    { from: "delia", channel: "introductions", at: 170, text: "delia. ambient music + a very loud brain. hi 🌙", reactions: [{ from: "mika", emoji: "💚" }] },

    { id: "n-l1", from: "juno", channel: "resources", at: 1500, text: "this piece on adhd + object permanence explained my entire life. sharing in case it helps someone", embed: { type: "link", url: "https://www.simplypsychology.org/object-permanence-and-adhd.html", title: "Object Permanence & ADHD - Simply Psychology" }, reactions: [{ from: "luz", emoji: "🤯" }, { from: "ren-okafor", emoji: "💯" }, { from: "omar-k", emoji: "📌" }] },
    { from: "cora", channel: "hyperfixations", at: 1800, text: "3am ceramics dump. this time the hyperfixation produced actual objects", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Homa_at_the_wheel_02.JPG/960px-Homa_at_the_wheel_02.JPG" }, reactions: [{ from: "fern", emoji: "😍" }, { from: "mika", emoji: "💚" }, { from: "omar-k", emoji: "💜" }] },
    { id: "n-l2", from: "vic-osei", channel: "resources", at: 2200, text: "solid plain-language autism resource, links to the actual research, not just vibes", embed: { type: "link", url: "https://embrace-autism.com", title: "Embrace Autism" }, reactions: [{ from: "cora", emoji: "🙏" }, { from: "mika", emoji: "💯" }] },
    { from: "fern", channel: "hyperfixations", at: 2500, text: "the moss notes have officially become a moss BINDER. no, i will not be seeking help 🌱", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/38/Moss_%28Bryophyta%29_on_the_forest_floor_in_Broken_Bow%2C_Oklahoma.jpg/960px-Moss_%28Bryophyta%29_on_the_forest_floor_in_Broken_Bow%2C_Oklahoma.jpg" }, reactions: [{ from: "cora", emoji: "😍" }, { from: "mika", emoji: "🌿" }] },
    { from: "omar-k", channel: "resources", at: 3000, text: "for anyone newly diagnosed: CHADD has solid, non-hyped info plus a support-group finder", embed: { type: "link", url: "https://chadd.org", title: "CHADD, ADHD support" }, reactions: [{ from: "juno", emoji: "💜" }, { from: "luz", emoji: "🙏" }] },

    // necro-replies to older posts
    { from: "luz", channel: "resources", at: 5000, replyTo: "n-l1", replyMode: "thread", text: "necro-ing this because i finally read it and cried a little. thank you juno", reactions: [{ from: "juno", emoji: "🫂" }, { from: "omar-k", emoji: "💜" }] },
    { from: "mika", channel: "resources", at: 5200, replyTo: "n-l2", replyMode: "inline", text: "just got to this one. bookmarking forever, the research links are gold", reactions: [{ from: "vic-osei", emoji: "💚" }] },

    // sprinkled memes (real reposts)
    { from: "luz", channel: "ADHD", at: 2250, text: "HOLY SHIT YES. that's it that's the post", embed: { type: "image", url: "https://i.redd.it/xmeg0lmywfkf1.jpeg" }, reactions: [{ from: "nova", emoji: "💯" }, { from: "sasha-v", emoji: "😭" }, { from: "juno", emoji: "🙌" }] },
    { from: "juno", channel: "ADHD", at: 3500, text: "exactly how my brain works, illustrated", embed: { type: "image", url: "https://i.redd.it/slq15dmkhpjf1.jpeg" }, reactions: [{ from: "luz", emoji: "😂" }, { from: "omar-k", emoji: "😂" }, { from: "wolf", emoji: "💯" }] },
  ],
};

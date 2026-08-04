/**
 * The Basement, music server, scripted seed conversation.
 * Channels: alt, country, electronic, general, introductions, live events,
 * metal, new releases, now playing, off topic, rap, rock.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "the-basement",
  name: "The Basement",
  invite:
    "https://armada.buzz/invite/naddr1qvzqqqyzz5pzqhmnfls4tnw8g73y8vf67upfsc30g2n3cx07uqdy0em94mqktn4wqqqqptzxe8#BAADAwQBtoU_BRS3XZS_lZDUQQDMIw",
  startedAt: "2026-07-19T20:00:00Z",
  messages: [
    { from: "theo-m", channel: "introductions", at: 0, text: "hey all, theo. i make music in a closet studio, guitar, ableton, too many pedals. here to nerd out and share stuff" },
    { from: "luz", channel: "introductions", at: 15, text: "luztronica!! synthwave sets at 2am is my brand. if you like neon and arpeggios we're gonna get along", reactions: [{ from: "nova", emoji: "🔥" }] },
    { from: "bianca-r", channel: "introductions", at: 35, text: "Bianca 👋 house music is my cardio. teach pilates by day, dance in my kitchen by night.", reactions: [{ from: "luz", emoji: "💜" }] },
    { from: "mika", channel: "introductions", at: 60, text: "hi, mika (they/them). ambient + field recordings. i basically record moss. soft music for soft brains", reactions: [{ from: "theo-m", emoji: "🌿" }, { from: "sasha-v", emoji: "💚" }] },
    { from: "kai-mendez", channel: "introductions", at: 85, text: "kai. vinyl crate digger, mostly funk/soul/hip-hop. my rent is 60% records", reactions: [{ from: "milo-tran", emoji: "😂" }] },
    { from: "milo-tran", channel: "introductions", at: 120, text: "milo, lofi tinkerer. i make beats that sound like a rainy window. glad the music nerds have a home" },

    { from: "sasha-v", channel: "general", at: 300, text: "what got you INTO music, making or loving it. the origin story. mine: a burned cd from a stranger at 14 changed my life!!!" },
    { from: "theo-m", channel: "general", at: 330, replyTo: 6, replyMode: "thread", text: "my dad's dusty guitar in a closet. taught myself one riff and never stopped", reactions: [{ from: "kai-mendez", emoji: "🎸" }] },
    { from: "mika", channel: "general", at: 360, replyTo: 6, replyMode: "thread", text: "a thunderstorm through a cheap tape recorder. i realized sound could be a place", reactions: [{ from: "sasha-v", emoji: "🤯" }, { from: "theo-m", emoji: "💯" }] },
    { from: "rai", channel: "general", at: 400, replyTo: 6, replyMode: "thread", text: "chiptune in gameboy games honestly. those 4 channels taught me melody", reactions: [{ from: "quinn", emoji: "🙌" }] },
    { from: "nova", channel: "general", at: 460, text: "hot take: the best music discovery is still a friend going 'you HAVE to hear this'. algorithms could never", reactions: [{ from: "bianca-r", emoji: "💯" }, { from: "kai-mendez", emoji: "💯" }] },

    { from: "luz", channel: "new releases", at: 900, text: "dropped a new synthwave track last night, 3am brain-child. no pressure to listen, ok maybe a little pressure 👉👈", reactions: [{ from: "theo-m", emoji: "🔥" }, { from: "nova", emoji: "🔥" }, { from: "mika", emoji: "💜" }] },
    { from: "theo-m", channel: "new releases", at: 930, replyTo: 11, replyMode: "thread", text: "that breakdown at 2 minutes is filthy in the best way. what synth is the lead?" },
    { from: "luz", channel: "new releases", at: 960, replyTo: 12, replyMode: "thread", text: "vital! free and stupidly powerful. i'll send you the preset", reactions: [{ from: "theo-m", emoji: "🙏" }] },
    { from: "kai-mendez", channel: "new releases", at: 1400, text: "not mine but that new reissue is a grower. skip track 1, live on track 4", reactions: [{ from: "milo-tran", emoji: "👀" }] },

    { from: "mika", channel: "now playing", at: 1500, text: "on loop: rain on a tin roof i recorded last week, layered under a soft pad. it's just for me but it's everything" },
    { from: "bianca-r", channel: "now playing", at: 1540, text: "house mix while i meal prep. sunday ritual. the bassline does the chopping for me 🔪🎶", reactions: [{ from: "luz", emoji: "😂" }] },
    { from: "quinn", channel: "now playing", at: 1600, text: "chiptune covers of metal songs. yes it's exactly as good as it sounds", reactions: [{ from: "rai", emoji: "🤘" }] },

    { from: "luz", channel: "electronic", at: 1900, text: "the synthwave vs synthpop discourse is so silly. it's all just feelings with a saw wave", reactions: [{ from: "nova", emoji: "💯" }] },
    { from: "nova", channel: "electronic", at: 1930, replyTo: 18, replyMode: "inline", text: "'feelings with a saw wave' is the best genre definition i've ever heard", reactions: [{ from: "luz", emoji: "🥹" }] },

    { from: "theo-m", channel: "rock", at: 2300, text: "the eternal question: is the guitar solo back? i think we're in a quiet renaissance", reactions: [{ from: "kai-mendez", emoji: "🎸" }] },
    { from: "quinn", channel: "metal", at: 2600, text: "chiptune metal counts as metal. i will not be taking questions", reactions: [{ from: "rai", emoji: "🤘" }, { from: "milo-tran", emoji: "😂" }] },
    { from: "kai-mendez", channel: "rap", at: 2900, text: "boom bap will never die. the dusty sample + hard drums combo is eternal", reactions: [{ from: "milo-tran", emoji: "💯" }] },
    { from: "mika", channel: "alt", at: 3200, text: "slowcore appreciation post. music that moves at the speed of a slow afternoon", reactions: [{ from: "sasha-v", emoji: "💚" }] },
    { from: "sasha-v", channel: "country", at: 3400, text: "ok hear me out: outlaw country and punk are the same genre spiritually!!! change my mind", reactions: [{ from: "kai-mendez", emoji: "🤠" }, { from: "theo-m", emoji: "👀" }] },

    { from: "bianca-r", channel: "live events", at: 3700, text: "who's going to shows this summer? i need a warehouse set in my life again" },
    { from: "kai-mendez", channel: "live events", at: 3740, replyTo: 25, replyMode: "thread", text: "there's a soul night at a little bar downtown next month, all vinyl dj. i'll drop details", reactions: [{ from: "bianca-r", emoji: "🙌" }] },
    { from: "luz", channel: "live events", at: 3800, replyTo: 25, replyMode: "thread", text: "i'm playing a tiny synthwave night in a few weeks!! terrified. will share when tickets are up", reactions: [{ from: "nova", emoji: "🔥" }, { from: "theo-m", emoji: "🔥" }] },

    { from: "milo-tran", channel: "off topic", at: 4100, text: "my cat has decided my studio chair is hers now. i record standing up like a fool", reactions: [{ from: "bianca-r", emoji: "😹" }, { from: "mika", emoji: "🐈" }] },
    { from: "rai", channel: "off topic", at: 4200, text: "does anyone else tie specific albums to specific games. like i can't hear one record without smelling a specific rpg", reactions: [{ from: "mika", emoji: "💯" }] },
    { from: "theo-m", channel: "off topic", at: 4260, replyTo: 29, replyMode: "inline", text: "yes and it's the most powerful memory trigger i own. scent + sound is unfair" },

    // ── content layer: shared tracks, videos, memes; intermixed + necro-replies ──
    { from: "delia", channel: "introductions", at: 90, text: "delia. bandcamp crawler, ambient + drone. i find the music before the algorithm does 🎧", reactions: [{ from: "mika", emoji: "💚" }, { from: "theo-m", emoji: "👋" }] },
    { from: "tomo", channel: "introductions", at: 130, text: "tomo, mostly here for the music discovery. i make clips but i'll behave", reactions: [{ from: "luz", emoji: "👋" }] },
    { from: "goose", channel: "introductions", at: 170, text: "honk. here to post music memes exclusively", reactions: [{ from: "nova", emoji: "😂" }] },

    { id: "b-l1", from: "delia", channel: "new releases", at: 1400, text: "found a tiny ambient release that's been on repeat all week. name-your-price, go support the artist", embed: { type: "link", url: "https://stellardrone.bandcamp.com/album/light-years", title: "Light Years, by Stellardrone" }, reactions: [{ from: "mika", emoji: "💜" }, { from: "theo-m", emoji: "🙏" }, { from: "sasha-v", emoji: "🔥" }] },
    { id: "b-v1", from: "kai-mendez", channel: "rock", at: 1800, text: "reminder that bohemian rhapsody is a perfect song and i will not be hearing otherwise", embed: { type: "video", url: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ", title: "Queen – Bohemian Rhapsody" }, reactions: [{ from: "theo-m", emoji: "💯" }, { from: "milo-tran", emoji: "🔥" }, { from: "nova", emoji: "🙌" }] },
    { from: "theo-m", channel: "rock", at: 2100, text: "the sweet child o' mine intro is still the best guitar tone ever recorded. i said what i said", embed: { type: "video", url: "https://www.youtube.com/watch?v=1w7OgIMMRc4", title: "Guns N' Roses – Sweet Child O' Mine" }, reactions: [{ from: "kai-mendez", emoji: "🎸" }, { from: "quinn", emoji: "🤘" }] },
    { from: "nova", channel: "electronic", at: 2400, text: "posting sandstorm completely unironically. it slaps and you know it", embed: { type: "video", url: "https://www.youtube.com/watch?v=y6120QOlsfU", title: "Darude – Sandstorm" }, reactions: [{ from: "luz", emoji: "😂" }, { from: "goose", emoji: "💀" }] },
    { from: "goose", channel: "off topic", at: 2700, text: "producers at 3am, colorized", embed: { type: "image", url: "https://i.imgflip.com/1c1uej.jpg" }, reactions: [{ from: "theo-m", emoji: "😭" }, { from: "luz", emoji: "😭" }, { from: "milo-tran", emoji: "😹" }] },
    { from: "quinn", channel: "metal", at: 3000, text: "chiptune cover incoming eventually but the original back in black is simply untouchable", embed: { type: "video", url: "https://www.youtube.com/watch?v=pAgnJDJN4VA", title: "AC/DC – Back In Black" }, reactions: [{ from: "rai", emoji: "🤘" }, { from: "kai-mendez", emoji: "🔥" }] },
    { from: "theo-m", channel: "new releases", at: 3300, text: "ok go's 'here it goes again', one take, treadmills, zero cgi. still the gold standard for a music video", embed: { type: "video", url: "https://www.youtube.com/watch?v=dTAAsCNK7RA", title: "OK Go – Here It Goes Again" }, reactions: [{ from: "bianca-r", emoji: "😍" }, { from: "nova", emoji: "🤯" }] },

    // necro-replies to older posts
    { from: "sasha-v", channel: "new releases", at: 5000, replyTo: "b-l1", replyMode: "thread", text: "just found this thread and bought the whole release. thank you delia!!!", reactions: [{ from: "delia", emoji: "🥹" }] },
    { from: "milo-tran", channel: "rock", at: 5200, replyTo: "b-v1", replyMode: "inline", text: "necro but i play this in full every single time it comes on. no skips, ever", reactions: [{ from: "kai-mendez", emoji: "💯" }] },

    // sprinkled memes (real reposts)
    { from: "goose", channel: "off topic", at: 3900, text: "same meaning, different energy", embed: { type: "image", url: "https://i.redd.it/q9dcrllw81tf1.jpeg" }, reactions: [{ from: "kai-mendez", emoji: "😂" }, { from: "theo-m", emoji: "💀" }] },
    { from: "nova", channel: "off topic", at: 4400, text: "real and true.", embed: { type: "image", url: "https://i.redd.it/wyvgsl4fr94h1.jpeg" }, reactions: [{ from: "luz", emoji: "💯" }, { from: "mika", emoji: "😂" }] },
  ],
};

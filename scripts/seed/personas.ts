/**
 * The global persona roster: whole people, each a member of 1..4 communities.
 *
 * `interests` and `voice` are authoring aids (never published), they keep each
 * persona's dialogue consistent across every channel and community they appear
 * in. `profileMetadata` builds the kind-0 content.
 *
 * Most personas use avatar-style images (illustrated humans or characters they'd
 * actually pick); a minority use real photos, so the roster reads like a real
 * community rather than a wall of headshots. Everything is deterministic, so a
 * dry-run preview and a live push produce identical profiles.
 */

import type { CommunityKey, Persona } from "./types";

/** Stable 0..mod-1 index from an id (for picking a portrait). */
function indexFrom(id: string, mod: number): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % mod;
}

/**
 * Real → a gender-correct photo (randomuser has 0..99 per set). Anon → a
 * DiceBear character/illustrated style the persona would actually pick.
 */
function defaultAvatar(p: Persona): string {
  if (p.style === "real") {
    const set = p.gender === "woman" ? "women" : "men";
    return `https://randomuser.me/api/portraits/${set}/${indexFrom(p.id, 100)}.jpg`;
  }
  const style = p.avatarStyle ?? "bottts";
  return `https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(p.id)}`;
}

/** Deterministic banner from a seeded photo service. */
function defaultBanner(p: Persona): string {
  return `https://picsum.photos/seed/${encodeURIComponent(p.id)}-banner/1200/400`;
}

/**
 * Hand-picked, real, per-persona profile pictures, chosen to fit each person
 * (their gear, pet, aesthetic, hobby), like real Discord users. Every one is
 * unique. Personas NOT listed here (the "real"-style folks) fall back to a
 * gender-correct portrait. Sourced from Wikimedia Commons (hotlinkable CDN).
 */
const PICTURES: Record<string, string> = {
  "nova": "https://safebooru.org/images/841/36efad4a481b4fa05b77dfaa5ce029e68d7eff37.jpg",
  "bex": "https://safebooru.org/images/841/70e39204becc7b6514eb92f7130770f2bf0ea8b4.jpg",
  "kai-mendez": "https://safebooru.org/images/72/baa694ccca30131825a1e0b8f2b0e21f698e9e4b.jpg",
  "deshawn": "https://safebooru.org/images/580/b75f1f37c1ab43e1a6135f2d4c6db35ed5a2637b.jpg",
  "rai": "https://safebooru.org/images/584/a01a070f1266d32a5167aa4a5e00fb135da6c16d.jpg",
  "hana-lee": "https://safebooru.org/images/841/efb00f5c25cc0593cdaeb8b9f4a361aaf21723c9.jpg",
  "otto-k": "https://safebooru.org/images/1096/0b587315f439fc65b1b9001aac2224ee1bc7110a.jpg",
  "saanvi": "https://safebooru.org/images/1096/f312883c427192bbdbf981daebd4d275ace649d8.jpg",
  "cora": "https://safebooru.org/images/65/0ed5c1a06cdbd71d837848ab45b1a86e462dacb9.jpg",
  "tomo": "https://safebooru.org/images/841/3382b891666bb99eb2143cd572ced6a445652fff.jpg",
  "milo-tran": "https://safebooru.org/images/329/edc646cd657f74377f989569ce6eb2298f1f7572.png",
  "quinn": "https://safebooru.org/images/839/f2933da1088ecb061bda8404ca1cd12901676c51.jpg",
  "luz": "https://safebooru.org/images/837/051bd5d4a6b13d8a77f523ef9c97c71161819c6e.png",
  "gordo": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/Commodore-64-Computer-FL.jpg/960px-Commodore-64-Computer-FL.jpg",
  "mika": "https://upload.wikimedia.org/wikipedia/commons/c/ca/Moss_Close-up_-_geograph.org.uk_-_2757596.jpg",
  "delia": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d0/Foggy_autumn_forest_in_the_morning_2.jpg/960px-Foggy_autumn_forest_in_the_morning_2.jpg",
  "dook": "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Australia_green_tree_frog_%28Litoria_caerulea%29_crop.jpg/960px-Australia_green_tree_frog_%28Litoria_caerulea%29_crop.jpg",
  "yuki": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/960px-Cat_November_2010-1a.jpg",
  "wolf": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Front_view_of_a_resting_Canis_lupus_ssp.jpg/960px-Front_view_of_a_resting_Canis_lupus_ssp.jpg",
  "goose": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/39/Domestic_Goose.jpg/960px-Domestic_Goose.jpg",
  "juno": "https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Opossum_2.jpg/960px-Opossum_2.jpg",
  "marcus-a": "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Head_Marcus_Aurelius_archmus_Heraklion.jpg/960px-Head_Marcus_Aurelius_archmus_Heraklion.jpg",
  "vic-osei": "https://upload.wikimedia.org/wikipedia/commons/0/03/Portrait_of_Sherlock_Holmes_by_Sidney_Paget-Cropped.jpg",
  "tibs": "https://upload.wikimedia.org/wikipedia/commons/8/86/Sigurd_kills_Fafnir_by_Rackham.jpg",
  "pete-s": "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/The_book_of_romance%3B_%281902%29_%2814566284027%29.jpg/960px-The_book_of_romance%3B_%281902%29_%2814566284027%29.jpg",
  "fern": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Four_fern_fronds%2C_one_of_a_hart%27s_tongue_fern_%28Asplenium_spe_Wellcome_V0043925.jpg/960px-Four_fern_fronds%2C_one_of_a_hart%27s_tongue_fern_%28Asplenium_spe_Wellcome_V0043925.jpg",
  "ren-okafor": "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/Tux%2C_the_Linux_penguin_I_-_Thumbnail.jpg/960px-Tux%2C_the_Linux_penguin_I_-_Thumbnail.jpg",
  "priya-sundaram": "https://upload.wikimedia.org/wikipedia/commons/9/97/Aditi_Rao_Hydari_at_Cafe_Coffee_Day_01.jpg",
  "omar-k": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Belly_Laugh%2C_Dassanech%2C_Ethiopia_%2822294760894%29.jpg/960px-Belly_Laugh%2C_Dassanech%2C_Ethiopia_%2822294760894%29.jpg",
  "sasha-v": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Future_Music_Festival_2013_%288540647429%29.jpg/960px-Future_Music_Festival_2013_%288540647429%29.jpg",
  "dan-oshea": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Young_attractive_man_athlete_doing_exercise_with_the_barbell_in_the_gym.jpg/960px-Young_attractive_man_athlete_doing_exercise_with_the_barbell_in_the_gym.jpg",
  "marta-c": "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Jogging_the_North_Gateway_%28ce13fa56-ccd6-4afd-b487-cb27b1ac2bdf%29.JPG/960px-Jogging_the_North_Gateway_%28ce13fa56-ccd6-4afd-b487-cb27b1ac2bdf%29.JPG",
  "bianca-r": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Personal_training_sit_ups.jpg/960px-Personal_training_sit_ups.jpg",
  "theo-m": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Jason_Wagner_acoustic_guitar_Our_Community_Place_Harrisonburg_VA_April_2008.jpg/960px-Jason_Wagner_acoustic_guitar_Our_Community_Place_Harrisonburg_VA_April_2008.jpg",
  "jae-park": "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/UBER_Eats_Delivery_Cyclist_Riding_Through_a_Busy_Oxford_Road_in_Manchester.jpg/960px-UBER_Eats_Delivery_Cyclist_Riding_Through_a_Busy_Oxford_Road_in_Manchester.jpg",
};

/** The kind-0 metadata object to publish for a persona. */
export function profileMetadata(p: Persona): Record<string, string> {
  const meta: Record<string, string> = {
    name: p.handle,
    about: p.about,
    picture: p.picture ?? PICTURES[p.id] ?? defaultAvatar(p),
    banner: p.banner ?? defaultBanner(p),
  };
  if (p.displayName) meta.display_name = p.displayName;
  if (p.website) meta.website = p.website;
  return meta;
}

export const PERSONAS: Persona[] = [
  {
    id: "milo-tran",
    handle: "miloraccoon",
    displayName: "Milo",
    style: "anon",
    avatarStyle: "micah",
    about: "tinkerer. ex-discord mod who got tired of it. building mechanical keyboards + lo-fi playlists.",
    communities: ["discord-refugees", "gaming", "the-basement"],
    interests: ["indie games", "lo-fi beats", "mechanical keyboards", "self-hosting"],
    voice: "lowercase, warm, casual, occasional 'lol'/'ngl', medium-length sentences",
  },
  {
    id: "ren-okafor",
    handle: "renegade_ren",
    style: "anon",
    avatarStyle: "bottts",
    about: "self-host everything. degoogled. autistic wiring, adhd brain. ask me about my homelab.",
    communities: ["discord-refugees", "neurodivergents"],
    interests: ["privacy", "linux", "homelab", "cats"],
    voice: "terse, technical, lowercase, no emoji, drops articles sometimes",
  },
  {
    id: "priya-sundaram",
    handle: "priyacodes",
    displayName: "Priya",
    style: "real",
    gender: "woman",
    about: "backend dev, marathon-in-training, flat white enthusiast. she/her.",
    communities: ["discord-refugees", "health-fitness"],
    interests: ["backend dev", "running", "coffee", "postgres"],
    voice: "tidy punctuation, upbeat, one emoji now and then",
  },
  {
    id: "dook",
    handle: "dookiebrown",
    style: "anon",
    avatarStyle: "fun-emoji",
    about: "professional deck-goldfisher. i peaked in a roguelike run once.",
    communities: ["discord-refugees", "gaming", "edh"],
    interests: ["magic: the gathering", "roguelikes", "shitposting"],
    voice: "chaotic, lowercase, meme-y, short bursts, no periods",
  },
  {
    id: "hana-lee",
    handle: "hana",
    displayName: "Hana",
    style: "anon",
    avatarStyle: "notionists",
    about: "cooking my way through every cuisine. yoga in the morning, film photos on weekends.",
    communities: ["discord-refugees", "vegans", "health-fitness"],
    interests: ["cooking", "yoga", "film photography", "plants"],
    voice: "gentle, thoughtful, complete sentences, sparse emoji",
  },
  {
    id: "gordo",
    handle: "gordogordon",
    style: "anon",
    avatarStyle: "pixel-art",
    about: "i miss geocities. analog synths and a rotary phone. get off my lawn (respectfully).",
    communities: ["discord-refugees"],
    interests: ["90s web", "forums nostalgia", "analog synths", "ham radio"],
    voice: "rambly, ellipses everywhere, older-internet cadence, dry",
  },
  {
    id: "sasha-v",
    handle: "sashka",
    style: "anon",
    avatarStyle: "open-peeps",
    about: "techno + zines + mutual aid. if it's not encrypted i'm not saying it here!!!",
    communities: ["discord-refugees", "neurodivergents", "the-basement"],
    interests: ["techno", "activism", "zines", "encryption"],
    voice: "energetic, lowercase, lots of !!!, run-ons",
  },
  {
    id: "theo-m",
    handle: "theo_makes",
    displayName: "Theo",
    style: "anon",
    avatarStyle: "avataaars",
    about: "make music in a closet studio. guitar, ableton, too many pedals.",
    communities: ["discord-refugees", "the-basement"],
    interests: ["music production", "guitar", "ableton", "coffee"],
    voice: "chill, complete sentences, understated",
  },
  {
    id: "bex",
    handle: "bexdrawsstuff",
    style: "anon",
    avatarStyle: "lorelei",
    about: "i draw little guys. animal crossing is a lifestyle. commissions closed sorry :(",
    communities: ["discord-refugees", "gaming"],
    interests: ["illustration", "animal crossing", "anime"],
    voice: "soft, friendly, emoji, uses :) and :( and ~",
  },
  {
    id: "marcus-a",
    handle: "marcusaurelius",
    displayName: "Marcus",
    style: "anon",
    avatarStyle: "notionists",
    about: "board games, whiskey, and a bit of stoicism. dad of two, deck of ninety-nine.",
    communities: ["discord-refugees", "edh"],
    interests: ["board games", "commander", "whiskey", "stoicism"],
    voice: "measured, dry humor, proper sentences",
  },
  {
    id: "yuki",
    handle: "yukisnows",
    style: "anon",
    avatarStyle: "big-ears",
    about: "sourdough, cottagecore, three cats. probably baking right now.",
    communities: ["discord-refugees", "vegans"],
    interests: ["baking", "cottagecore", "cats", "tea"],
    voice: "cozy, warm, gentle, some emoji",
  },
  {
    id: "dan-oshea",
    handle: "danoshea",
    displayName: "Dan",
    style: "real",
    gender: "man",
    about: "lift heavy, aim straight, sleep eight. two kids, one barbell.",
    communities: ["discord-refugees", "health-fitness", "gaming"],
    interests: ["lifting", "fps games", "dad life", "protein"],
    voice: "blunt, friendly, short, no fluff",
  },
  {
    id: "nova",
    handle: "novaqueen",
    style: "anon",
    avatarStyle: "adventurer",
    about: "vrchat gremlin, edm, i stream sometimes. touch grass? never heard of her 💅",
    communities: ["discord-refugees", "gaming", "the-basement", "neurodivergents"],
    interests: ["vrchat", "edm", "streaming", "fashion"],
    voice: "hype, emoji-heavy, gamer/online slang, short",
  },
  {
    id: "omar-k",
    handle: "omarkhalid",
    displayName: "Omar",
    style: "real",
    gender: "man",
    about: "therapist-in-training, weekend runner, girl-dad. here for the good conversations.",
    communities: ["discord-refugees", "neurodivergents", "health-fitness"],
    interests: ["mental health", "running", "parenting", "books"],
    voice: "earnest, supportive, warm, well-punctuated",
  },
  {
    id: "quinn",
    handle: "quinnbyte",
    style: "anon",
    avatarStyle: "pixel-art",
    about: "retro consoles, chiptune, and a soldering iron. crt or bust.",
    communities: ["discord-refugees", "gaming", "the-basement"],
    interests: ["retro consoles", "chiptune", "modding", "electronics"],
    voice: "nerdy-precise, enthusiastic, specific",
  },
  {
    id: "jae-park",
    handle: "jaepark",
    displayName: "Jae",
    style: "real",
    gender: "man",
    about: "nutrition nerd, cyclist, meal-preps on sundays. evidence over hype.",
    communities: ["health-fitness", "vegans"],
    interests: ["nutrition science", "cycling", "meal prep"],
    voice: "informative, calm, cites sources, measured",
  },
  {
    id: "tibs",
    handle: "tibbers_",
    style: "anon",
    avatarStyle: "bottts",
    about: "commander is the only format. budget brews > cedh (fight me). i track card prices for fun.",
    communities: ["edh", "gaming"],
    interests: ["commander", "budget brews", "tcg finance"],
    voice: "knowledgeable, jargon-heavy, opinionated",
  },
  {
    id: "fern",
    handle: "ferngully",
    style: "anon",
    avatarStyle: "lorelei",
    about: "foraging, gardening, a little herbalism. the woods are my group chat.",
    communities: ["vegans", "neurodivergents"],
    interests: ["foraging", "gardening", "herbalism"],
    voice: "dreamy, lowercase, unhurried",
  },
  {
    id: "kai-mendez",
    handle: "kaicombos",
    displayName: "Kai",
    style: "anon",
    avatarStyle: "adventurer",
    about: "fighting games, vinyl crates, and a growing commander problem. FGC til i die.",
    communities: ["gaming", "the-basement", "edh"],
    interests: ["fighting games", "vinyl records", "commander", "arcades"],
    voice: "hype but literate, some FGC slang, medium length",
  },
  {
    id: "luz",
    handle: "luztronica",
    style: "anon",
    avatarStyle: "adventurer",
    about: "synthwave sets at 2am. i stream, i game, i do not sleep. adhd's strongest soldier.",
    communities: ["the-basement", "gaming", "neurodivergents"],
    interests: ["synthwave", "streaming", "indie games"],
    voice: "night-owl energy, lowercase, emoji, playful",
  },
  {
    id: "bianca-r",
    handle: "biancaruiz",
    displayName: "Bianca",
    style: "real",
    gender: "woman",
    about: "pilates instructor, smoothie scientist, house music on repeat. she/her.",
    communities: ["health-fitness", "vegans", "the-basement"],
    interests: ["pilates", "smoothies", "house music", "mobility"],
    voice: "encouraging, bright, complete sentences, a few emoji",
  },
  {
    id: "pete-s",
    handle: "petethedm",
    displayName: "Pete",
    style: "anon",
    avatarStyle: "big-smile",
    about: "forever DM. paint minis badly, brew decks worse. snacks are non-negotiable at my table.",
    communities: ["edh", "gaming"],
    interests: ["dungeon mastering", "commander", "miniature painting"],
    voice: "storyteller, warm, a bit long-winded",
  },
  {
    id: "saanvi",
    handle: "saanvibakes",
    displayName: "Saanvi",
    style: "anon",
    avatarStyle: "lorelei",
    about: "plant-based baker + weekend cyclist. i will convert you with a good cookie.",
    communities: ["vegans", "health-fitness"],
    interests: ["vegan baking", "cycling", "meal prep"],
    voice: "friendly, practical, recipe-brain, some emoji",
  },
  {
    id: "wolf",
    handle: "lonewolf88",
    style: "anon",
    avatarStyle: "bottts",
    about: "cedh grinder. i optimize everything, including my anxiety. wr > vibes (mostly).",
    communities: ["edh", "neurodivergents"],
    interests: ["competitive edh", "deck optimization", "spreadsheets"],
    voice: "precise, competitive, lowercase, blunt",
  },
  {
    id: "mika",
    handle: "mikamoss",
    style: "anon",
    avatarStyle: "big-ears",
    about: "ambient music + moss appreciation. they/them. soft on the outside, feral about field recordings.",
    communities: ["vegans", "neurodivergents", "the-basement"],
    interests: ["ambient music", "field recording", "foraging", "moss"],
    voice: "gentle, lowercase, thoughtful, unhurried",
  },
  {
    id: "deshawn",
    handle: "deshawnlifts",
    displayName: "DeShawn",
    style: "anon",
    avatarStyle: "avataaars",
    about: "powerlifting meet prep + madden dynasty grinder. squat, snap, repeat.",
    communities: ["health-fitness", "gaming"],
    interests: ["powerlifting", "madden", "meal prep"],
    voice: "upbeat, motivating, short punchy lines",
  },
  {
    id: "cora",
    handle: "coraclay",
    displayName: "Cora",
    style: "anon",
    avatarStyle: "lorelei",
    about: "ceramicist, herbal tea hoarder, autistic + proud. my hands are always covered in clay.",
    communities: ["vegans", "neurodivergents"],
    interests: ["ceramics", "herbal tea", "slow living"],
    voice: "calm, considered, warm, complete sentences",
  },
  {
    id: "rai",
    handle: "raicomet",
    style: "anon",
    avatarStyle: "pixel-art",
    about: "jrpg lifer, deckbuilder gremlin, chiptune on loop. currently 80 hours into something.",
    communities: ["gaming", "edh", "the-basement"],
    interests: ["jrpgs", "deckbuilding games", "chiptune"],
    voice: "enthusiastic, nerdy, lowercase, tangenty",
  },
  {
    id: "vic-osei",
    handle: "vicreads",
    displayName: "Vic",
    style: "anon",
    avatarStyle: "notionists",
    about: "news junkie, rss hoarder. i share the good links so you don't have to doomscroll.",
    communities: ["discord-refugees", "neurodivergents"],
    interests: ["tech news", "rss", "privacy policy"],
    voice: "concise, drops a link with a one-line take",
  },
  {
    id: "goose",
    handle: "honkgoose",
    style: "anon",
    avatarStyle: "croodles",
    about: "i post memes. that's the whole bio. honk.",
    communities: ["discord-refugees", "gaming", "the-basement"],
    interests: ["memes", "shitposting"],
    voice: "very short, lowercase, meme captions only",
  },
  {
    id: "tomo",
    handle: "tomoclips",
    style: "anon",
    avatarStyle: "adventurer",
    about: "i clip everything. if it was cool, i have a video of it.",
    communities: ["gaming", "the-basement"],
    interests: ["game clips", "youtube", "speedruns"],
    voice: "excited, shares videos, short",
  },
  {
    id: "delia",
    handle: "deliadrone",
    style: "anon",
    avatarStyle: "big-ears",
    about: "bandcamp crawler, ambient + drone. i find the music before the algorithm does.",
    communities: ["the-basement", "neurodivergents"],
    interests: ["bandcamp", "ambient", "music discovery"],
    voice: "soft, lowercase, shares links with a short note",
  },
  {
    id: "marta-c",
    handle: "martaruns",
    displayName: "Marta",
    style: "anon",
    avatarStyle: "lorelei",
    about: "sports-science reader. i share studies, not broscience. also i run a lot.",
    communities: ["health-fitness", "vegans"],
    interests: ["exercise science", "running", "research"],
    voice: "measured, cites sources, links papers",
  },
  {
    id: "otto-k",
    handle: "ottoeats",
    style: "anon",
    avatarStyle: "avataaars",
    about: "plant-based recipe collector + food-news bookmarker. i save everything.",
    communities: ["vegans", "health-fitness"],
    interests: ["recipes", "food news", "cooking videos"],
    voice: "friendly, shares recipe + video links",
  },
  {
    id: "juno",
    handle: "junotabs",
    style: "anon",
    avatarStyle: "open-peeps",
    about: "adhd, 47 tabs open. i share the good article from 46 of them.",
    communities: ["neurodivergents", "discord-refugees"],
    interests: ["adhd resources", "articles", "tools"],
    voice: "warm, shares resources with a kind note",
  },
];

const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

export function personaById(id: string): Persona | undefined {
  return BY_ID.get(id);
}

/** Everyone who belongs to a community (drives joins + the member roster). */
export function personasFor(key: CommunityKey): Persona[] {
  return PERSONAS.filter((p) => p.communities.includes(key));
}

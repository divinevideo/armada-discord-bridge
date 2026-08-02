/**
 * Vegans, scripted seed conversation. Non-preachy, food-forward tone.
 * Channels: activism, alternatives, cosmetics, events, food, general, memes,
 * nutrition, recipes, restaurants.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "vegans",
  name: "Vegans",
  invite:
    "https://armada.buzz/invite/naddr1qvzqqqyzz5pzpfklwjwfmw9fasyyu6504rpt6c387l5427s7qxyx6cq9r6efelnpqqqqytnp5t#BAADAwQBW8xBT8q0ERF9qax8GVolwA",
  startedAt: "2026-07-15T16:00:00Z",
  messages: [
    { from: "saanvi",     channel: "general", at: 0, text: "hi! saanvi, vegan baker + cyclist. been plant-based 6 years. here for recipe swaps and zero judgment" },
    { from: "hana-lee",     channel: "general", at: 16, text: "Hana 👋 not fully vegan but mostly plant-based and always curious. i cook constantly and want to learn." },
    { from: "yuki",     channel: "general", at: 34, text: "yuki! cottagecore sourdough goblin, vegan-ish, three cats who are NOT vegan and remind me daily 🐈", reactions: [{ from: "saanvi", emoji: "😂" }] },
    { from: "fern",     channel: "general", at: 55, text: "fern. foraging + gardening, i grow a lot of what i eat. the woods provide 🌿", reactions: [{ from: "mika", emoji: "💚" }] },
    { from: "jae-park",     channel: "general", at: 78, text: "jae, nutrition nerd. vegan for the science + ethics both. happy to help anyone worried about protein or b12", reactions: [{ from: "saanvi", emoji: "🙏" }] },
    { from: "mika",     channel: "general", at: 100, text: "mika (they/them). plant-based, ambient musician, moss enthusiast. gentle vibes only 🌱", reactions: [{ from: "cora", emoji: "💚" }] },
    { from: "cora",     channel: "general", at: 125, text: "cora, ceramicist. mostly vegan, fully tea-obsessed. i make the mugs you drink your oat-milk lattes from", reactions: [{ from: "yuki", emoji: "😍" }] },
    { from: "bianca-r",     channel: "general", at: 150, text: "Bianca! smoothie scientist + pilates teacher. plant-based fuels my workouts better than anything else, it converted me" },

    { from: "hana-lee", channel: "general", at: 300, text: "genuine q for the non-preachy crowd: what made it STICK for you? i've started and stopped a few times" },
    { from: "jae-park", channel: "general", at: 330, replyTo: 8, replyMode: "thread", text: "for me: i stopped framing it as restriction and started treating it as a cuisine to learn. curiosity beats willpower", reactions: [{ from: "hana-lee", emoji: "💯" }, { from: "saanvi", emoji: "💜" }] },
    { from: "fern", channel: "general", at: 360, replyTo: 8, replyMode: "thread", text: "growing my own veg did it. hard to feel deprived when dinner came out of the ground that morning", reactions: [{ from: "mika", emoji: "🌱" }] },
    { from: "saanvi", channel: "general", at: 400, replyTo: 8, replyMode: "thread", text: "finding replacements i actually LOVE, not just tolerate. once the food is genuinely good it stops being a struggle", reactions: [{ from: "hana-lee", emoji: "🙏" }] },
    { from: "bianca-r", channel: "general", at: 450, text: "reminder: 'perfect vegan' isn't the goal. a lot of people mostly-plant-based beats a few people being perfect", reactions: [{ from: "jae-park", emoji: "💯" }, { from: "cora", emoji: "💯" }] },

    { from: "saanvi", channel: "recipes", at: 900, text: "posting my foolproof vegan chocolate chip cookies. the secret is melted vegan butter + a rest in the fridge. thank me later", reactions: [{ from: "yuki", emoji: "😍" }, { from: "hana-lee", emoji: "🙏" }, { from: "bianca-r", emoji: "🔥" }] },
    { from: "yuki", channel: "recipes", at: 940, replyTo: 13, replyMode: "thread", text: "the fridge rest is non-negotiable for ANY cookie honestly. adding this to the weekend list", reactions: [{ from: "saanvi", emoji: "💜" }] },
    { from: "hana-lee", channel: "recipes", at: 1000, text: "made a mushroom bourguignon that fooled my very much not-vegan dad. rich, deep, zero notes", reactions: [{ from: "fern", emoji: "😍" }, { from: "saanvi", emoji: "👏" }] },
    { from: "fern", channel: "recipes", at: 1060, text: "wild garlic pesto season is upon us. foraged, blitzed, frozen in cubes. free flavor all year 🌿", reactions: [{ from: "mika", emoji: "💚" }, { from: "hana-lee", emoji: "😍" }] },

    { from: "cora", channel: "food", at: 1400, text: "the oat milk barista debate: genuinely the best plant milk for coffee, or propaganda i've happily fallen for?", reactions: [{ from: "bianca-r", emoji: "😂" }] },
    { from: "jae-park", channel: "food", at: 1430, replyTo: 17, replyMode: "inline", text: "the higher fat content genuinely steams better, so, propaganda that happens to be true", reactions: [{ from: "cora", emoji: "😂" }] },
    { from: "bianca-r", channel: "food", at: 1500, text: "my post-workout smoothie: banana, spinach, pea protein, peanut butter. tastes like a milkshake, lies to me beautifully", reactions: [{ from: "saanvi", emoji: "🔥" }] },

    { from: "jae-park", channel: "nutrition", at: 1800, text: "the protein question comes up constantly, so: lentils, tofu, tempeh, seitan, beans. hit your total, vary sources, you're fine. b12 supplement, always", reactions: [{ from: "hana-lee", emoji: "📌" }, { from: "cora", emoji: "🙏" }, { from: "saanvi", emoji: "💯" }] },
    { from: "saanvi", channel: "nutrition", at: 1840, replyTo: 20, replyMode: "thread", text: "the b12 note is the one people skip and shouldn't. it's cheap and non-negotiable", reactions: [{ from: "jae-park", emoji: "💯" }] },

    { from: "hana-lee", channel: "restaurants", at: 2200, text: "any all-vegan spots you'd travel for? planning a trip and building the itinerary entirely around food (no shame)" },
    { from: "bianca-r", channel: "restaurants", at: 2240, replyTo: 22, replyMode: "thread", text: "there's a vegan ramen place i'd genuinely relocate for. the broth is witchcraft", reactions: [{ from: "hana-lee", emoji: "😍" }] },
    { from: "yuki", channel: "restaurants", at: 2300, replyTo: 22, replyMode: "thread", text: "small vegan bakery near me does a cardamom bun that ruined all other buns for me forever", reactions: [{ from: "saanvi", emoji: "🥹" }] },

    { from: "cora", channel: "cosmetics", at: 2600, text: "cruelty-free skincare recs? trying to clean out my routine and the labeling is a maze" },
    { from: "fern", channel: "cosmetics", at: 2650, replyTo: 25, replyMode: "thread", text: "half my routine is stuff i make, oat + maple masks. cheap, no packaging, actually works", reactions: [{ from: "cora", emoji: "🌿" }] },

    { from: "mika", channel: "activism", at: 2900, text: "gentle activism > angry activism, for me. i've changed more minds with a good meal than an argument, every time", reactions: [{ from: "fern", emoji: "💯" }, { from: "hana-lee", emoji: "💜" }, { from: "cora", emoji: "🫂" }] },
    { from: "jae-park", channel: "activism", at: 2940, replyTo: 27, replyMode: "thread", text: "the data backs you up honestly, people move toward what feels welcoming, not what feels judged", reactions: [{ from: "mika", emoji: "💚" }] },

    { from: "saanvi", channel: "events", at: 3200, text: "thinking of organizing a virtual vegan bake-along, everyone makes the same recipe on a call. who's in?", reactions: [{ from: "yuki", emoji: "🙋" }, { from: "hana-lee", emoji: "🙋" }, { from: "bianca-r", emoji: "🙋" }, { from: "cora", emoji: "🙋" }] },

    { from: "yuki", channel: "memes", at: 3400, text: "'you'll never guess what i had for dinner' *proceeds to describe an incredible meal that happens to be vegan*, me, insufferably, daily", reactions: [{ from: "saanvi", emoji: "💀" }, { from: "hana-lee", emoji: "😂" }, { from: "mika", emoji: "😂" }] },

    // ── content layer: recipe links, food photos, a meme; necro-replies ──
    { from: "otto-k", channel: "general", at: 90, text: "otto here! plant-based recipe hoarder. i'll be dropping links + food pics, apologies to your appetite in advance", reactions: [{ from: "saanvi", emoji: "👋" }, { from: "hana-lee", emoji: "👋" }] },
    { from: "marta-c", channel: "general", at: 130, text: "marta! plant-based runner, i share the studies. hi all 🌱", reactions: [{ from: "jae-park", emoji: "🙏" }] },

    { id: "v-l1", from: "saanvi", channel: "recipes", at: 1400, text: "minimalist baker is my most-used vegan recipe site, everything's ~10 ingredients and actually works", embed: { type: "link", url: "https://minimalistbaker.com", title: "Minimalist Baker" }, reactions: [{ from: "yuki", emoji: "😍" }, { from: "hana-lee", emoji: "🙏" }, { from: "otto-k", emoji: "💯" }] },
    { from: "hana-lee", channel: "food", at: 1700, text: "the creamy mushroom risotto that fooled my very-much-not-vegan dad, pic as promised", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/e/e5/%EB%BD%81%EC%8B%9D%EB%8B%B9_%EB%A8%B8%EC%89%AC%EB%A3%B8_%ED%81%AC%EB%A6%BC_%EB%A6%AC%EC%A1%B0%EB%98%90_2.jpg" }, reactions: [{ from: "saanvi", emoji: "😍" }, { from: "fern", emoji: "👏" }] },
    { from: "otto-k", channel: "recipes", at: 2000, text: "this week's lunches, prepped and packed. future me says thanks", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Panda_bento_box_lunch_%288446540806%29.jpg/960px-Panda_bento_box_lunch_%288446540806%29.jpg" }, reactions: [{ from: "bianca-r", emoji: "🙌" }, { from: "saanvi", emoji: "💜" }] },
    { id: "v-l2", from: "jae-park", channel: "nutrition", at: 2300, text: "nutritionfacts.org for whole-food evidence, dr greger's team does the meta-analyses so we don't have to", embed: { type: "link", url: "https://nutritionfacts.org", title: "NutritionFacts.org" }, reactions: [{ from: "marta-c", emoji: "💯" }, { from: "cora", emoji: "🙏" }] },
    { id: "v-m1", from: "mika", channel: "memes", at: 2600, text: "the 'why do vegans make their food taste like meat' discourse, settled in one image", embed: { type: "image", url: "https://i.redd.it/dmtx68bik6ag1.png" }, reactions: [{ from: "yuki", emoji: "💀" }, { from: "saanvi", emoji: "😂" }, { from: "hana-lee", emoji: "😂" }, { from: "otto-k", emoji: "💯" }] },
    { from: "fern", channel: "food", at: 2900, text: "today's foraged + garden haul. dinner is basically free 🌿", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/52/Beetroots_in_a_basket.jpg/960px-Beetroots_in_a_basket.jpg" }, reactions: [{ from: "mika", emoji: "🌿" }, { from: "cora", emoji: "😍" }] },

    // more memes channel: real reposts, spread out
    { from: "otto-k", channel: "memes", at: 3100, text: "'a veggie hot dog?? made from PLANTS??' buddy. wait til you hear what the regular one is made from", embed: { type: "image", url: "https://i.redd.it/ec7rn195bd7g1.jpeg" }, reactions: [{ from: "mika", emoji: "😂" }, { from: "jae-park", emoji: "💀" }] },
    { from: "saanvi", channel: "memes", at: 3900, text: "the 'look at our teeth' guys have logged on", embed: { type: "image", url: "https://i.redd.it/zl9ipkbhh8eh1.png" }, reactions: [{ from: "yuki", emoji: "😂" }, { from: "fern", emoji: "💀" }, { from: "cora", emoji: "😂" }] },
    { from: "yuki", channel: "memes", at: 4100, replyTo: "v-m1", replyMode: "inline", text: "necro but i just sent this to my brother mid-argument. instant win", reactions: [{ from: "mika", emoji: "🏆" }] },
    { from: "hana-lee", channel: "memes", at: 4300, text: "every time. EVERY time.", embed: { type: "image", url: "https://i.redd.it/qgmrgejbjsdg1.jpeg" }, reactions: [{ from: "saanvi", emoji: "😭" }, { from: "otto-k", emoji: "💯" }] },

    // necro-replies to older posts
    { from: "yuki", channel: "recipes", at: 4500, replyTo: "v-l1", replyMode: "thread", text: "necro-ing this, made 3 recipes from here this week, all bangers. thank you saanvi", reactions: [{ from: "saanvi", emoji: "🥹" }] },
    { from: "cora", channel: "nutrition", at: 4700, replyTo: "v-l2", replyMode: "inline", text: "just watched a few of these. genuinely reassuring, bookmarked the whole site", reactions: [{ from: "jae-park", emoji: "💯" }] },
  ],
};

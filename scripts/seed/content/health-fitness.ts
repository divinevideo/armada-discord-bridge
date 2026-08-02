/**
 * Health & Fitness, scripted seed conversation. Supportive, anti-toxic tone.
 * Channels: general, introductions, mental health, nutrition, workouts.
 */

import type { CommunitySeed } from "../types";

export const seed: CommunitySeed = {
  key: "health-fitness",
  name: "Health & Fitness",
  invite:
    "https://armada.buzz/invite/naddr1qvzqqqyzz5pzq22sjtvx84qf8yyzahx6swhavq9xqrj4tu0guk4ft0htfal0ux28qqqq7svh2f#BAADAwQBTh9DCfxpHlzKrDZlOpVUhg",
  startedAt: "2026-07-21T13:00:00Z",
  messages: [
    { from: "priya-sundaram", channel: "introductions", at: 0, text: "Hi! Priya, backend dev training for my first marathon. Currently at the 'why did I sign up for this' stage 😅" },
    { from: "dan-oshea", channel: "introductions", at: 14, text: "dan. powerlifting-ish, two kids, i lift at 5am because it's the only quiet hour i own", reactions: [{ from: "deshawn", emoji: "💪" }] },
    { from: "deshawn", channel: "introductions", at: 22, replyTo: 1, replyMode: "inline", text: "5am club respect. that's the real strength stat", reactions: [{ from: "dan-oshea", emoji: "🤝" }] },
    { from: "bianca-r", channel: "introductions", at: 40, text: "Bianca 👋 pilates instructor, mobility evangelist. i promise your hips will thank you eventually", reactions: [{ from: "priya-sundaram", emoji: "🙏" }] },
    { from: "saanvi", channel: "introductions", at: 60, text: "saanvi! plant-based baker + weekend cyclist. living proof you can eat cookies and still ride 60 miles", reactions: [{ from: "jae-park", emoji: "😂" }] },
    { from: "jae-park", channel: "introductions", at: 80, text: "jae, nutrition nerd and cyclist. i'm the guy who reads the study before believing the headline", reactions: [{ from: "saanvi", emoji: "💯" }] },
    { from: "hana-lee", channel: "introductions", at: 105, text: "Hana. yoga most mornings, cooking always. here for the balanced, non-punishing side of fitness.", reactions: [{ from: "omar-k", emoji: "💜" }] },
    { from: "omar-k", channel: "introductions", at: 130, text: "Omar, weekend runner + therapist-in-training. big believer that mental and physical health are the same conversation", reactions: [{ from: "hana-lee", emoji: "💯" }] },

    { from: "priya-sundaram", channel: "general", at: 300, text: "what's everyone's actual 'why'? not the aesthetic one. mine: i want to be strong enough to keep up with life at 80" },
    { from: "omar-k", channel: "general", at: 330, replyTo: 8, replyMode: "thread", text: "to manage my anxiety, honestly. a run does more for my head than almost anything else", reactions: [{ from: "priya-sundaram", emoji: "💯" }, { from: "hana-lee", emoji: "🫂" }] },
    { from: "dan-oshea", channel: "general", at: 360, replyTo: 8, replyMode: "thread", text: "so my kids see it's normal. they copy everything i do, might as well copy this", reactions: [{ from: "bianca-r", emoji: "🥹" }] },
    { from: "bianca-r", channel: "general", at: 420, text: "friendly reminder that rest days ARE training days. your muscles grow when you're not in the gym!!", reactions: [{ from: "deshawn", emoji: "💯" }, { from: "priya-sundaram", emoji: "📌" }] },

    { from: "dan-oshea", channel: "workouts", at: 900, text: "hit a 405 deadlift this morning. been chasing it for a year. screamed a little. worth it", reactions: [{ from: "deshawn", emoji: "🔥" }, { from: "priya-sundaram", emoji: "🔥" }, { from: "omar-k", emoji: "👏" }] },
    { from: "deshawn", channel: "workouts", at: 930, replyTo: 12, replyMode: "thread", text: "LETS GO. a year of work paying off. what was the programming?" },
    { from: "dan-oshea", channel: "workouts", at: 970, replyTo: 13, replyMode: "thread", text: "boring linear progression + patience. the boring stuff works, that's the annoying secret", reactions: [{ from: "jae-park", emoji: "💯" }] },
    { from: "bianca-r", channel: "workouts", at: 1000, text: "beginner-friendly mobility flow if anyone wants it, 10 min, no equipment, just a floor and a willingness to feel silly", reactions: [{ from: "hana-lee", emoji: "🙏" }, { from: "priya-sundaram", emoji: "🙏" }] },
    { from: "priya-sundaram", channel: "workouts", at: 1060, text: "long run done. 18 miles. i have never wanted a shower and a nap so badly in my life 😅", reactions: [{ from: "omar-k", emoji: "🏅" }, { from: "saanvi", emoji: "🔥" }] },

    { from: "jae-park", channel: "nutrition", at: 1400, text: "psa: 'clean eating' isn't a scientific term. protein, fiber, mostly whole foods, enough calories. the rest is marketing", reactions: [{ from: "saanvi", emoji: "💯" }, { from: "priya-sundaram", emoji: "📌" }, { from: "hana-lee", emoji: "💯" }] },
    { from: "saanvi", channel: "nutrition", at: 1440, replyTo: 17, replyMode: "thread", text: "THANK YOU. the moralizing around food does more harm than any single ingredient ever could", reactions: [{ from: "jae-park", emoji: "💯" }] },
    { from: "hana-lee", channel: "nutrition", at: 1480, text: "made a big batch of lentil soup that's basically free protein and freezes forever. recipe if anyone wants", reactions: [{ from: "saanvi", emoji: "😍" }, { from: "bianca-r", emoji: "🙌" }] },
    { from: "deshawn", channel: "nutrition", at: 1520, text: "meal prep sunday: 3 lbs chicken, rice, and enough tupperware to concern my family", reactions: [{ from: "dan-oshea", emoji: "😂" }] },
    { from: "jae-park", channel: "nutrition", at: 1560, replyTo: 20, replyMode: "inline", text: "the tupperware avalanche every time you open the cabinet is the powerlifter's burden", reactions: [{ from: "deshawn", emoji: "💀" }] },

    { from: "omar-k", channel: "mental health", at: 1900, text: "reminder: fitness culture can get toxic fast. if training feels like punishment, that's worth examining. movement should add to your life, not tax it", reactions: [{ from: "hana-lee", emoji: "💯" }, { from: "bianca-r", emoji: "💜" }, { from: "priya-sundaram", emoji: "🫂" }] },
    { from: "hana-lee", channel: "mental health", at: 1940, replyTo: 22, replyMode: "thread", text: "this is why i left the 'no days off' mindset behind. i train because i like being alive in my body, not to earn the right to it", reactions: [{ from: "omar-k", emoji: "💯" }] },
    { from: "priya-sundaram", channel: "mental health", at: 2000, text: "some days the win is just going for a walk instead of doom-scrolling. counting it.", reactions: [{ from: "omar-k", emoji: "🫂" }, { from: "saanvi", emoji: "💜" }] },
    { from: "bianca-r", channel: "mental health", at: 2040, replyTo: 24, replyMode: "inline", text: "that absolutely counts. showing up small is still showing up", reactions: [{ from: "priya-sundaram", emoji: "💜" }] },

    { from: "saanvi", channel: "general", at: 2500, text: "this is the first fitness space that hasn't made me feel bad about myself. genuinely refreshing", reactions: [{ from: "omar-k", emoji: "💜" }, { from: "hana-lee", emoji: "🫂" }, { from: "priya-sundaram", emoji: "💯" }, { from: "bianca-r", emoji: "🥹" }] },

    // ── content layer: studies, recipes, progress photos; necro-replies ──
    { from: "marta-c", channel: "introductions", at: 90, text: "marta! i read sports-science papers so you don't have to. also i run too much. she/her", reactions: [{ from: "priya-sundaram", emoji: "👋" }, { from: "jae-park", emoji: "🙏" }] },
    { from: "otto-k", channel: "introductions", at: 130, text: "otto. i collect plant-based recipes + food news. my bookmarks folder is bottomless", reactions: [{ from: "saanvi", emoji: "👋" }] },

    { id: "h-l1", from: "marta-c", channel: "workouts", at: 1400, text: "the 'do i need to train to failure' debate, settled with actual data. tl;dr: mostly no, leave a rep or two", embed: { type: "link", url: "https://www.strongerbyscience.com/training-to-failure-or-just-training-to-fail/", title: "Training to Failure, or Just Training to Fail? - Stronger By Science" }, reactions: [{ from: "dan-oshea", emoji: "👀" }, { from: "deshawn", emoji: "🔥" }, { from: "priya-sundaram", emoji: "📌" }] },
    { from: "dan-oshea", channel: "workouts", at: 1700, text: "405 pull, photographic proof since y'all didn't believe me", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Fit_young_man_doing_deadlift_exercise_in_gym.jpg/960px-Fit_young_man_doing_deadlift_exercise_in_gym.jpg" }, reactions: [{ from: "deshawn", emoji: "🔥" }, { from: "priya-sundaram", emoji: "🔥" }, { from: "omar-k", emoji: "👏" }] },
    { id: "h-l2", from: "jae-park", channel: "nutrition", at: 2100, text: "examine.com is my go-to for cutting through supplement hype. no sponsors, just the evidence", embed: { type: "link", url: "https://examine.com", title: "Examine, nutrition evidence" }, reactions: [{ from: "marta-c", emoji: "💯" }, { from: "saanvi", emoji: "🙏" }] },
    { from: "saanvi", channel: "nutrition", at: 2400, text: "high-protein lunch ideas that aren't sad desk salads", embed: { type: "link", url: "https://www.bbcgoodfood.com/recipes/collection/high-protein-lunch-recipes", title: "High protein lunch recipes - BBC Good Food" }, reactions: [{ from: "hana-lee", emoji: "🙏" }, { from: "bianca-r", emoji: "😍" }] },
    { from: "bianca-r", channel: "workouts", at: 2700, text: "today's mobility setup: floor, foam roller, and a questionable playlist", embed: { type: "image", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Hartschaumrolle.jpg/960px-Hartschaumrolle.jpg" }, reactions: [{ from: "priya-sundaram", emoji: "🙌" }, { from: "hana-lee", emoji: "💜" }] },

    // necro-replies to older posts
    { from: "deshawn", channel: "workouts", at: 4200, replyTo: "h-l1", replyMode: "thread", text: "necro but this changed my programming. left 1-2 in the tank, still growing. wild", reactions: [{ from: "marta-c", emoji: "💯" }, { from: "dan-oshea", emoji: "🔥" }] },
    { from: "hana-lee", channel: "nutrition", at: 4400, replyTo: "h-l2", replyMode: "inline", text: "just found this, canceled 3 supplements i didn't need. thanks jae", reactions: [{ from: "jae-park", emoji: "🙏" }] },

    // sprinkled memes (real reposts)
    { from: "dan-oshea", channel: "nutrition", at: 1600, text: "nutrition advice from my worst decisions", embed: { type: "image", url: "https://i.redd.it/fbwpgeaydwxg1.jpeg" }, reactions: [{ from: "jae-park", emoji: "😂" }, { from: "deshawn", emoji: "💀" }, { from: "saanvi", emoji: "😂" }] },
    { from: "deshawn", channel: "workouts", at: 2900, text: "no excuses today. just go", embed: { type: "image", url: "https://i.redd.it/facn3y4jrwdg1.jpeg" }, reactions: [{ from: "dan-oshea", emoji: "🔥" }, { from: "bianca-r", emoji: "💯" }, { from: "marta-c", emoji: "🙌" }] },
  ],
};

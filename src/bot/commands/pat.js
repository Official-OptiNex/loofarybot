// /pat [part] [user] — headpats & friends. A `part` autocomplete field (not subcommands, so there's no
// 25-cap) lets you pick a named part with its own pool of cringy responses, pick a hyper-specific one
// ("left foot pinky toe"), or just type your own. Optionally @someone. One pat per user per minute.
const { SlashCommandBuilder } = require('discord.js');

const COOLDOWN_MS = 60 * 1000; // per user — others are unaffected
const cooldowns = new Map(); // userId -> last pat timestamp (in-memory; a restart just clears it)

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Named parts with their own bespoke pools. {t} = target ("you" / "<@id>"), {p} = possessive.
const PARTS = {
  head: { emoji: '🫳', responses: [
    'Rawr roff rawr :3 >~< *pat pat pat*',
    '*gently boops {p} head* there there, smol bean 🫶',
    'headpats acquired ✅ serotonin +100 📈',
    '*pats {p} head* **good noodle.** certified. do not question it 🧠✨',
    'pspspsps~ *pat* 🐾 you are Officially A Little Guy now',
    '*taps {p} head like a tiny drum* bonk bonk bonk 🥁',
    'uwu *headpat* your brainworms have been soothed 🪱💤',
    '`[headpat.exe has stopped responding]` …*keeps patting anyway* 🖐️',
    'pat. pat. pat. the prophecy is fulfilled 📜🫳',
    '*floofs {p} hair into a little tuft* :3 nyehe' ] },
  hair: { emoji: '💆', responses: [
    '*ruffles {p} hair* now it is Chaos™ and I refuse to fix it 🌪️',
    'sfffff *scritches {p} scalp* oh you are PURRING, do not deny it 😼',
    '*braids a tiny braid in {p} hair* it says "loser" in it, affectionately 💝',
    'hair = floofed. mission status: **adorable** ✅',
    '*gently detangles a knot* this took 45 minutes and my sanity 💀🪮',
    'pat pat *tuft goes boing* 🌱 a little sprout has appeared' ] },
  cheeks: { emoji: '🤲', responses: [
    '*smooshes {p} cheeks together* bleh 🐟 you look like a little fish now',
    'squish. squish. *squish* 🫧 i have decided these are stress balls',
    '*pinches {p} cheek like a weird aunt* "LOOK HOW BIG YOU GOT" 👵',
    'boop the cheek 👉😳 ok that was weird of me but i stand by it',
    'mochi cheeks detected 🍡 *pokes* …mochi cheeks confirmed' ] },
  nose: { emoji: '👉', responses: [
    '*boops {p} nose* **BOOP** 🔴 you are now cursed with being perceived',
    'honk 🤡 (that was your nose. i honked it. no regrets)',
    '*taps {p} snoot* boop’d. the snoot has been boop’d. it is law now ⚖️',
    'nyoom *boop* 👃 ok i will stop… *boop* …i lied' ] },
  ears: { emoji: '🐰', responses: [
    '*scritches behind {p} ears* ohhh the leg is going. the leg is DEFINITELY going 🦵💨',
    'floppy ear… *flop*… floppy ear… *flop* 🐶 i could do this all day',
    '*gently folds {p} ear and unfolds it* origami. you are origami now 🦊',
    'ear scritch unlocked 🔓 warning: involuntary purring may occur 😽' ] },
  chin: { emoji: '☝️', responses: [
    '*scritches under {p} chin* chin chin chin 🐈 who’s a little guy. it’s you.',
    '*tilts {p} chin up* "you have stupid eyes" <- a compliment, promise 💫',
    'chin scritches +10 ✨ you are legally required to purr now 📜' ] },
  forehead: { emoji: '😚', responses: [
    '*pats {p} forehead* big brain real estate 🧠🏠 prime property',
    'fivehead? sixhead? *pat* we do not discriminate here 📏',
    '*gentle forehead pat* think smaller thoughts, you are overclocking 🔥💻' ] },
  shoulders: { emoji: '🫂', responses: [
    '*pat pat* carry the weight no longer, i am stealing it 🎒 (i will drop it immediately)',
    '*massages {p} shoulders* oh these are TIGHT, what are you holding in here, war crimes??',
    'shoulder pat 👔 "you’re doing great sweetie" - unlicensed life coach me' ] },
  back: { emoji: '🤗', responses: [
    '*pat pat pat on the back* there there. let it out. (not here though, you’re in public) 😭',
    '*firm supportive back pat* you did it champ 🏆 (we do not know what "it" is)',
    'back pats 📦 handle with care, this side up ⬆️, fragile precious cargo' ] },
  tummy: { emoji: '🫄', responses: [
    '*pat pat* round. respectfully. the tummy is round and that is lovely 🫶',
    'belly rubs?? *checks for permission* …*rubs anyway* BRRRR 🥁',
    '*drum solo on {p} tummy* badum tss 🥁 thank you, i’m here all week' ] },
  hands: { emoji: '🤝', responses: [
    '*holds {p} hands and pats them* 🫱🫲 we are besties now, legally binding',
    'hand pat 🖐️ (high five that lost its confidence halfway through)',
    '*pat* little paws 🐾 little beans 🫘 i am going to lose my mind over them' ] },
  arms: { emoji: '💪', responses: [
    '*pats {p} arm* "there there" 🫱 (the universal gesture for i have no idea what to say)',
    'noodle arms? strong arms? 🍜 *pat* beautiful either way king/queen/entity',
    '*pat pat* flexing? *pat* i will pretend i saw something 💪😐' ] },
  legs: { emoji: '🦵', responses: [
    '*pats {p} leg* good leg. sturdy leg. 10/10 would stand on 🦵✅',
    'leg pat 🦿 keep walking little guy, one foot in front of the other ✨',
    '*pat pat* these are your running-away-from-responsibilities legs, treasure them 🏃💨' ] },
  feet: { emoji: '🦶', responses: [
    '*pats {p} feet* …ok that WAS weird, you’re right, i’m sorry 😳🦶',
    'tippy taps 🫳 *pat pat* little foots. the little foots.',
    '*boops the toe beans* 🫘 wait those are feet not paws, awkward 😭',
    'feet pat 🦶 delivering one (1) cursed blessing upon your soles 👻' ] },
  chest: { emoji: '🫅', responses: [
    '*pat pat* big heart in there ❤️ i can tell. it’s doing its little job.',
    '*taps {p} chest* "the power was inside you all along" 🌟 (it was cringe. the power was cringe.)',
    'chest pat 🫀 ba-dump ba-dump 💓 ok your heart is working, you pass inspection ✅' ] },
  knees: { emoji: '🧎', responses: [
    '*pats {p} knees* creaky? 🦴 *pat* don’t worry we’re all falling apart together',
    'knee pat 🧎 weak in them? for me? 🥺 (it’s probably just the cartilage)',
    '*boops kneecap* 🦵 the little hinge! i love the little hinge!' ] },
  paws: { emoji: '🐾', responses: [
    '*holds {p} paws* beans 🫘 BEANS 🫘🫘 i am obsessed with the beans',
    'pawpat 🐾 *mlem* toe beans certified squishy ✅ 11/10',
    '*gently presses a paw* 🐾 *boop noise plays* bthp. the paw said bthp.',
    'murr… *pat pat* the paws… they have been patted… good paws… 🐺' ] },
  snoot: { emoji: '👃', responses: [
    'boop the snoot 👉👃 *BOOP* the snoot has been boop’d, kingdom rejoice 🏰',
    '*boop* 🐽 snoot acquired. snoot boop’d. snoot vibrating. 📳',
    'the snoot? *boops it* booped. this is a snoot-boop household now 🏠🐾' ] },
  tail: { emoji: '🦊', responses: [
    '*pat pat* the tail is WAGGING, you cannot hide it from me 🐕💨',
    'floof tail 🦊 *gently pats* now it is a little poofier, you’re welcome',
    '*pats {p} tail* wagwagwag 🌀 someone’s happy and it’s adorable and embarrassing',
    'tail = patted 🐺 danger noodle status: **content** 😌' ] },
  neck: { emoji: '🦒', responses: [
    '*pats {p} neck* long neck? short neck? perfect neck 🦒 *pat pat*',
    'scritch scritch down the neck 🐈 you’re basically a cat now, accept your fate',
    '*gentle neck pat* support your local spine 🦴 it carries your giant head all day',
    'nape scritches 🫳 *involuntary shiver detected* 📳 caught you lacking' ] },
  boop: { emoji: '👉', responses: [
    '*boops you on the nearest available surface* 👉😳 BOOP. no take-backs.',
    'surprise boop! 🫵 you have been booped by forces beyond your control 🌌',
    '*boop* 🔴 *boop* 🔵 *boop* 🟢 congratulations you are a traffic light now 🚦',
    'incoming boop in 3… 2… *BOOP* 💥 (there was no 1. the boop was early. chaos reigns.)',
    'boop’d 📮 consider this your daily serotonin delivery, no refunds, no returns 🫶' ] },
  fluff: { emoji: '🌸', responses: [
    '*floofs you up into a big poof* 🌸 you are now 3× fluffier and 0% more useful',
    'sfffff *fluff fluff* static electricity +1000 ⚡ you are a balloon now, float away',
    '*buries hands in the floof and vanishes* 🫥 send help, the floof has won',
    'fluff status: **maximum** 🧸 you have achieved Plushie. good job little one 🫶' ] },
  horns: { emoji: '😈', responses: [
    '*pats between {p} horns* lil menace 😈 pointy on top, soft on the inside 🫶',
    'honk the horns? 📯 *honk* ok that felt wrong but i would absolutely do it again',
    '*polishes {p} horns* ✨ now they are SHINY, go forth and be dramatic 🐉',
    'horn pat 🔱 danger level: **terrifying** 💀 cuddliness level: also terrifying' ] },
  wings: { emoji: '🪽', responses: [
    '*gently pats {p} wings* 🪽 flappy flappy, little airplane 🛫',
    'preen preen 🐦 there — one feather was crooked and it was personally offending me',
    '*boops the wing joint* 🪽 do NOT take off indoors, we talked about this 😤',
    'wing pat ✨ certified flight-worthy 🛬 (please do not actually fly, liability reasons)' ] }
};

// Hyper-specific parts: pick one from the list, OR just type your own — they all share the pool below,
// with {part} swapped in. "a lot", as requested.
const SPECIFIC = [
  'left foot pinky toe', 'right foot pinky toe', 'left big toe', 'right big toe', 'the third toe (the mysterious one)',
  'left heel', 'right arch', 'left toe beans', 'right toe beans', 'the gap between your toes',
  'left pinky finger', 'right thumb', 'the middle knuckle', 'left index fingertip', 'the webbing between your fingers',
  'left ear lobe', 'right ear tip', 'inside the left ear (gently)', 'the little ear floof',
  'left eyebrow', 'right eyebrow', 'the think-wrinkle between your eyebrows', 'left dimple', 'right dimple',
  'the tip of your nose', 'left nostril', 'the philtrum (nose-to-lip groove)', 'left cheekbone', 'the chin crease',
  'left temple', 'the cowlick', 'that one stubborn hair', 'the widow’s peak', 'the exact center of your forehead',
  'left elbow', 'the inside of your right elbow', 'left wrist bone', 'the back of your right hand', 'left knuckles',
  'left kneecap', 'the back of your left knee', 'left shin', 'the right ankle bone',
  'left collarbone', 'the right shoulder blade', 'the small of your back', 'a left floating rib',
  'the dip above your tailbone', 'left hip bone', 'the belly button (respectfully)',
  'the very summit of your head', 'the flat spot on the back of your head', 'the soft spot',
  'left horn tip', 'the right wing joint', 'the base of your tail', 'a floppy left ear', 'the tip of the snoot',
  'left paw pad', 'the one single whisker', 'the scruff of your neck',
  'the left side of your left pinky toe', 'the 4th eyelash on your left eye', 'the concept of your elbow',
  'your aura (left side)', 'your inner child (gently)', 'the vibe'
];

const SPECIFIC_RESPONSES = [
  '*pats {p} {part} with surgical precision* 🔬 nobody has EVER been this specific 🫶',
  'the {part}?? 😳 bold. oddly specific. *pat* respect ✊',
  '*locates {p} {part} on the official diagram* 📋 *pat pat* target acquired ✅',
  'patting the {part} 🫳 scientists are baffled. i am baffled. we are all patting the {part} now.',
  '*gently pats {p} {part}* 🥹 that one needed it the most. you knew. i knew.',
  'you asked for the {part} and by god you’re getting the {part} 💪 *pat*',
  '*zooms in on {p} {part}* 🔍 enhance… enhance… *BOOP* 👉',
  '{part} = patted ✅ achievement unlocked: **Hyper-Specific Affection** 🏆',
  'i consulted the ancient scrolls 📜 the {part} is indeed pattable. *pat*',
  '*whispers to {p} {part}* "you matter too" 🫧 (it’s crying. the {part} is crying.)',
  'the {part}?? that’s a deep cut 💿 *pat pat* i see you, connoisseur',
  'deploying one (1) pat to the {part} 🚀 coordinates locked 🛰️ *bap*',
  '*pats the {part}* 🫳 anatomy teachers HATE this one simple move 🧑‍🏫💢'
];

// Weird/creepy lines that can surface on ANY pat at random (uncanny, not gross) — {part}/{p} work here too.
const CREEPY_CHANCE = 0.16; // ~1 in 6 pats
const CREEPY = [
  '*pats {p} {part}* …i have been counting them. all of them. i know the exact number 🙂',
  '{p} {part} feels the same as it did last night. when you were asleep. 🫥',
  '*pat* …do not turn around. the pat did not come from in front of you 👁️',
  'i memorized {p} {part} so i can always find you again. isn’t that sweet 🫶🙂',
  '*gently pats {p} {part}* it is warm. i will remember that it is warm. forever 🕯️',
  'the walls told me about {p} {part}. the walls tell me everything 🧱👂',
  '*pat pat* i made a little shrine. it’s mostly {part}. so many candles. you’d love it 🕯️🕯️',
  'shhh. the {part} is mine now. i signed the papers. you were asleep. you signed too ✍️😴',
  '*pats {p} {part} with hands that are not quite hands* 🫳…🫳…🫳 how many do you count?',
  'i can hear {p} {part}. it hums. do you hear it too? …you will soon 📻',
  '*pat* there. now we’re connected. forever. there is no undo 🔗🙂',
  'i was already here. inside the {part}. i’ve always been in the {part} 🫥',
  'smile for me :) …good. i kept that one. i have all of them now 📸',
  '*pats the {part}* it recognizes me. it always does. welcome home 🚪',
  'the {part}. yes. that’s the one from the dream. you’re right on schedule 🕰️'
];

const ALL_PARTS = [...Object.keys(PARTS), ...SPECIFIC];
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);

const data = new SlashCommandBuilder()
  .setName('pat')
  .setDescription('Give someone (or a very specific body part) a pat 🫳')
  .addStringOption((o) => o.setName('part').setDescription('What to pat — pick one, or type your own (e.g. "left foot pinky toe")').setAutocomplete(true))
  .addUserOption((o) => o.setName('user').setDescription('Who to pat (leave empty to just be silly)'));

async function autocomplete(interaction) {
  const q = (interaction.options.getFocused() || '').toLowerCase().trim();
  const matches = (q ? ALL_PARTS.filter((p) => p.toLowerCase().includes(q)) : ALL_PARTS)
    .sort((a, b) => (a.toLowerCase().startsWith(q) ? 0 : 1) - (b.toLowerCase().startsWith(q) ? 0 : 1))
    .slice(0, 25)
    .map((p) => ({ name: p.length > 100 ? p.slice(0, 100) : p, value: p.slice(0, 100) }));
  return interaction.respond(matches);
}

async function execute(interaction) {
  // Per-user cooldown — one pat a minute each; everyone else is free to pat.
  const now = Date.now();
  const last = cooldowns.get(interaction.user.id) || 0;
  if (now - last < COOLDOWN_MS) {
    const left = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    return interaction.reply({ content: `⏳ your paws need a breather — you can **/pat** again in **${left}s**. (others can still pat!)`, ephemeral: true });
  }
  cooldowns.set(interaction.user.id, now);
  if (cooldowns.size > 1000) for (const [id, t] of cooldowns) if (now - t >= COOLDOWN_MS) cooldowns.delete(id); // tidy up

  const raw = clean(interaction.options.getString('part'));
  const key = raw.toLowerCase();
  let partName, def;
  if (!raw) { partName = pick(Object.keys(PARTS)); def = PARTS[partName]; } // no part → surprise
  else if (PARTS[key]) { partName = key; def = PARTS[key]; } // a named part
  else { partName = raw; def = { emoji: '🫳', responses: SPECIFIC_RESPONSES }; } // specific / freeform

  const target = interaction.options.getUser('user');
  const self = !target || target.id === interaction.user.id;
  const them = self ? 'you' : `<@${target.id}>`;
  const their = self ? 'your' : `<@${target.id}>'s`;

  // Every so often, something... else... answers the pat instead.
  const pool = Math.random() < CREEPY_CHANCE ? CREEPY : def.responses;
  const line = pick(pool).replace(/\{part\}/g, partName).replace(/\{t\}/g, them).replace(/\{p\}/g, their);
  const prefix = self ? '' : `*${interaction.user} pats ${their} ${partName}* ${def.emoji}\n`;

  return interaction.reply({
    content: `${prefix}${line}`,
    allowedMentions: { users: !self && target ? [target.id] : [] } // only ever ping the person patted
  });
}

module.exports = { data, execute, autocomplete, PARTS, SPECIFIC, SPECIFIC_RESPONSES, CREEPY, COOLDOWN_MS, _cooldowns: cooldowns };

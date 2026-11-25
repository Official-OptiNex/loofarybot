// /pat <part> [user] — headpats and friends. Each body part has its own pile of cringy / weird / funny
// responses (plain text + emoji + markdown), picked at random. Optionally pat someone by @mentioning them.
const { SlashCommandBuilder } = require('discord.js');

// Each part: an emoji + a verb for the "*pats …*" action, and a big pool of responses.
// {t} = the target ("you" or "<@id>'s"), {p} = possessive ("your" or "<@id>'s"). Keep it playful/SFW.
const PARTS = {
  head: {
    emoji: '🫳',
    responses: [
      'Rawr roff rawr :3 >~< *pat pat pat*',
      '*gently boops {p} head* there there, smol bean 🫶',
      'headpats acquired ✅ serotonin +100 📈',
      '*pats {p} head* **good noodle.** certified. do not question it 🧠✨',
      'pspspsps~ *pat* 🐾 you are Officially A Little Guy now',
      '*taps {p} head like a tiny drum* bonk bonk bonk 🥁',
      'uwu *headpat* your brainworms have been soothed 🪱💤',
      '`[headpat.exe has stopped responding]` …*keeps patting anyway* 🖐️',
      'pat. pat. pat. the prophecy is fulfilled 📜🫳',
      '*floofs {p} hair into a little tuft* :3 nyehe'
    ]
  },
  hair: {
    emoji: '💆',
    responses: [
      '*ruffles {p} hair* now it is Chaos™ and I refuse to fix it 🌪️',
      'sfffff *scritches {p} scalp* oh you are PURRING, do not deny it 😼',
      '*braids a tiny braid in {p} hair* it says "loser" in it, affectionately 💝',
      'hair = floofed. mission status: **adorable** ✅',
      '*gently detangles a knot* this took 45 minutes and my sanity 💀🪮',
      'pat pat *tuft goes boing* 🌱 a little sprout has appeared'
    ]
  },
  cheeks: {
    emoji: '🤲',
    responses: [
      '*smooshes {p} cheeks together* bleh 🐟 you look like a little fish now',
      'squish. squish. *squish* 🫧 i have decided these are stress balls',
      '*pinches {p} cheek like a weird aunt* "LOOK HOW BIG YOU GOT" 👵',
      'boop the cheek 👉😳 ok that was weird of me but i stand by it',
      'mochi cheeks detected 🍡 *pokes* …mochi cheeks confirmed'
    ]
  },
  nose: {
    emoji: '👉',
    responses: [
      '*boops {p} nose* **BOOP** 🔴 you are now cursed with being perceived',
      'honk 🤡 (that was your nose. i honked it. no regrets)',
      '*taps {p} snoot* boop’d. the snoot has been boop’d. it is law now ⚖️',
      'nyoom *boop* 👃 ok i will stop… *boop* …i lied'
    ]
  },
  ears: {
    emoji: '🐰',
    responses: [
      '*scritches behind {p} ears* ohhh the leg is going. the leg is DEFINITELY going 🦵💨',
      'floppy ear… *flop*… floppy ear… *flop* 🐶 i could do this all day',
      '*gently folds {p} ear and unfolds it* origami. you are origami now 🦊',
      'ear scritch unlocked 🔓 warning: involuntary purring may occur 😽'
    ]
  },
  chin: {
    emoji: '☝️',
    responses: [
      '*scritches under {p} chin* chin chin chin 🐈 who’s a little guy. it’s you.',
      '*tilts {p} chin up* "you have stupid eyes" <- a compliment, promise 💫',
      'chin scritches +10 ✨ you are legally required to purr now 📜'
    ]
  },
  forehead: {
    emoji: '😚',
    responses: [
      '*pats {p} forehead* big brain real estate 🧠🏠 prime property',
      'fivehead? sixhead? *pat* we do not discriminate here 📏',
      '*gentle forehead pat* think smaller thoughts, you are overclocking 🔥💻'
    ]
  },
  shoulders: {
    emoji: '🫂',
    responses: [
      '*pat pat* carry the weight no longer, i am stealing it 🎒 (i will drop it immediately)',
      '*massages {p} shoulders* oh these are TIGHT, what are you holding in here, war crimes??',
      'shoulder pat 👔 "you’re doing great sweetie" - unlicensed life coach me'
    ]
  },
  back: {
    emoji: '🤗',
    responses: [
      '*pat pat pat on the back* there there. let it out. (not here though, you’re in public) 😭',
      '*firm supportive back pat* you did it champ 🏆 (we do not know what "it" is)',
      'back pats 📦 handle with care, this side up ⬆️, fragile precious cargo'
    ]
  },
  tummy: {
    emoji: '🫄',
    responses: [
      '*pat pat* round. respectfully. the tummy is round and that is lovely 🫶',
      'belly rubs?? *checks for permission* …*rubs anyway* BRRRR 🥁',
      '*drum solo on {p} tummy* badum tss 🥁 thank you, i’m here all week'
    ]
  },
  hands: {
    emoji: '🤝',
    responses: [
      '*holds {p} hands and pats them* 🫱🫲 we are besties now, legally binding',
      'hand pat 🖐️ (high five that lost its confidence halfway through)',
      '*pat* little paws 🐾 little beans 🫘 i am going to lose my mind over them'
    ]
  },
  arms: {
    emoji: '💪',
    responses: [
      '*pats {p} arm* "there there" 🫱 (the universal gesture for i have no idea what to say)',
      'noodle arms? strong arms? 🍜 *pat* beautiful either way king/queen/entity',
      '*pat pat* flexing? *pat* i will pretend i saw something 💪😐'
    ]
  },
  legs: {
    emoji: '🦵',
    responses: [
      '*pats {p} leg* good leg. sturdy leg. 10/10 would stand on 🦵✅',
      'leg pat 🦿 keep walking little guy, one foot in front of the other ✨',
      '*pat pat* these are your running-away-from-responsibilities legs, treasure them 🏃💨'
    ]
  },
  feet: {
    emoji: '🦶',
    responses: [
      '*pats {p} feet* …ok that WAS weird, you’re right, i’m sorry 😳🦶',
      'tippy taps 🫳 *pat pat* little foots. the little foots.',
      '*boops the toe beans* 🫘 wait those are feet not paws, awkward 😭',
      'feet pat 🦶 delivering one (1) cursed blessing upon your soles 👻'
    ]
  },
  chest: {
    emoji: '🫅',
    responses: [
      '*pat pat* big heart in there ❤️ i can tell. it’s doing its little job.',
      '*taps {p} chest* "the power was inside you all along" 🌟 (it was cringe. the power was cringe.)',
      'chest pat 🫀 ba-dump ba-dump 💓 ok your heart is working, you pass inspection ✅'
    ]
  },
  knees: {
    emoji: '🧎',
    responses: [
      '*pats {p} knees* creaky? 🦴 *pat* don’t worry we’re all falling apart together',
      'knee pat 🧎 weak in them? for me? 🥺 (it’s probably just the cartilage)',
      '*boops kneecap* 🦵 the little hinge! i love the little hinge!'
    ]
  },
  paws: {
    emoji: '🐾',
    responses: [
      '*holds {p} paws* beans 🫘 BEANS 🫘🫘 i am obsessed with the beans',
      'pawpat 🐾 *mlem* toe beans certified squishy ✅ 11/10',
      '*gently presses a paw* 🐾 *boop noise plays* bthp. the paw said bthp.',
      'murr… *pat pat* the paws… they have been patted… good paws… 🐺'
    ]
  },
  snoot: {
    emoji: '👃',
    responses: [
      'boop the snoot 👉👃 *BOOP* the snoot has been boop’d, kingdom rejoice 🏰',
      '*boop* 🐽 snoot acquired. snoot boop’d. snoot vibrating. 📳',
      'the snoot? *boops it* booped. this is a snoot-boop household now 🏠🐾'
    ]
  },
  tail: {
    emoji: '🦊',
    responses: [
      '*pat pat* the tail is WAGGING, you cannot hide it from me 🐕💨',
      'floof tail 🦊 *gently pats* now it is a little poofier, you’re welcome',
      '*pats {p} tail* wagwagwag 🌀 someone’s happy and it’s adorable and embarrassing',
      'tail = patted 🐺 danger noodle status: **content** 😌'
    ]
  }
};

const data = new SlashCommandBuilder().setName('pat').setDescription('Give someone (or a body part) a pat 🫳');
for (const [part, def] of Object.entries(PARTS)) {
  data.addSubcommand((s) =>
    s
      .setName(part)
      .setDescription(`${def.emoji} Pat the ${part}`)
      .addUserOption((o) => o.setName('user').setDescription('Who to pat (leave empty to just be silly)'))
  );
}
data.addSubcommand((s) =>
  s
    .setName('random')
    .setDescription('🎲 Pat a random body part')
    .addUserOption((o) => o.setName('user').setDescription('Who to pat (leave empty to just be silly)'))
);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const part = sub === 'random' ? pick(Object.keys(PARTS)) : sub;
  const def = PARTS[part];
  if (!def) return interaction.reply({ content: '❓ I don’t know how to pat that.', ephemeral: true });

  const target = interaction.options.getUser('user');
  const self = !target || target.id === interaction.user.id;
  const them = self ? 'you' : `<@${target.id}>`;
  const their = self ? 'your' : `<@${target.id}>'s`;

  const line = pick(def.responses).replace(/\{t\}/g, them).replace(/\{p\}/g, their);
  // An action prefix only when patting someone else, so it reads like "X pats Y's head".
  const prefix = self ? '' : `*${interaction.user} pats ${their} ${part}* ${def.emoji}\n`;

  return interaction.reply({
    content: `${prefix}${line}`,
    // Ping only the person being patted (never @everyone/roles), and no one when it's a solo silly pat.
    allowedMentions: { users: !self && target ? [target.id] : [] }
  });
}

module.exports = { data, execute, PARTS };

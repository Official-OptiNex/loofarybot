// Single source of truth for every slash command, grouped the same way as the dashboard.
// Used by /loof help, the dashboard's Commands page and its search bar — kept separate from the
// SlashCommandBuilder definitions so the web side doesn't import discord.js command internals.
//
// perm: who can use it (null = everyone — these are also listed on the public home page).
// tab: the dashboard page for that module, if any.
module.exports = [
  {
    id: 'giveaways',
    group: 'Giveaways',
    icon: '🎁',
    blurb: 'Timed giveaways and first-to-click drops, with optional entry requirements.',
    tab: 'giveaways',
    commands: [
      { usage: '/loof create', perm: 'Admin', description: 'Set up a giveaway or drop in a form — type, channel, look, requirements, ping — with a live preview.' },
      { usage: '/loof start', perm: 'Admin', description: 'Start a timed giveaway or a drop right away — requirements and role bonus entries included.' },
      { usage: '/loof drop', perm: 'Admin', description: 'First-to-click drop — the first N people to press Claim win instantly.' },
      { usage: '/loof edit', perm: 'Admin', description: 'Change the prize, winners, end time, description, color or emoji of a running giveaway.' },
      { usage: '/loof requirements', perm: 'Admin', description: 'Require a role, days in the server, or an XP level to enter.' },
      { usage: '/loof end', perm: 'Admin', description: 'End a giveaway early and draw winners now.' },
      { usage: '/loof reroll', perm: 'Admin', description: 'Draw a new winner for an ended giveaway.' },
      { usage: '/loof delete', perm: 'Admin', description: 'Delete a giveaway and its message.' },
      { usage: '/loof entries', perm: 'Admin', description: 'See who entered a giveaway, with bonus entries and winners.' },
      { usage: '/loof list', perm: 'Admin', description: 'Running giveaways (with entries and jump links) and recently ended ones.' }
    ]
  },
  {
    id: 'leveling',
    group: 'Leveling',
    icon: '📈',
    blurb: 'Members earn XP for chatting, level up, and unlock role rewards.',
    tab: 'leveling',
    commands: [
      { usage: '/daily', perm: null, description: 'Claim daily XP — consecutive days build a streak for bigger rewards.' },
      { usage: '/idle play · start · stop · daily', perm: null, description: 'The Bubble Factory idle game (no gambling): make 🫧 over time, collect (with a 💎 Golden Bubble chance), claim a 🎁 daily streak bonus, upgrade, cash out to XP, and optionally ✨ Rebirth for permanent power.' },
      { usage: '/idle top · help', perm: null, description: 'The factory leaderboard (with ✨ rebirth levels), and a guide to how the Bubble Factory works.' },
      { usage: '/idle admin', perm: 'Manage Server', description: 'Everything is configurable: toggle the game, give/take/reset bubbles, tune upgrades, Rebirth (optional), the 🎁 daily bonus, the 💎 Golden Bubble, and grant ⭐ Stars / set a rebirth level — in-server or on the dashboard.' },
      { usage: '/xpdrop setup', perm: 'Manage Server', description: 'Random XP drops in chat — pick channels, XP range and how often; first to click wins.' },
      { usage: '/xpdrop now · status · toggle', perm: 'Manage Server', description: 'Drop one right now, see recent winners and the next drop, or turn drops on/off.' },
      { usage: '/perks show', perm: null, description: 'What server boosters get: extra gambles, giveaway entries, a daily XP drop and a thank-you package.' },
      { usage: '/perks config', perm: 'Manage Server', description: 'Change the booster perks and where drops are announced.' },
      { usage: '/levels rank', perm: null, description: "See your (or someone's) level, XP and server rank." },
      { usage: '/levels leaderboard', perm: null, description: 'The server XP leaderboard.' },
      { usage: '/levels card', perm: null, description: 'Customize your rank card color, background and tagline.' },
      { usage: '/levels xpconfig_show', perm: null, description: 'Show how XP is earned on this server.' },
      { usage: '/levels setrole', perm: 'Admin', description: 'Grant a role automatically at a level.' },
      { usage: '/levels removerole', perm: 'Admin', description: 'Remove a level role reward.' },
      { usage: '/levels colorroles setup', perm: 'Admin', description: 'Name-color roles every N levels — on/off, tiers and placement.' },
      { usage: '/levels colorroles set · color · reset', perm: 'Admin', description: 'Use your own role for a tier, recolor a tier, or reset it.' },
      { usage: '/levels colorroles list · sync', perm: 'Admin', description: 'See every tier, or give all members their color now.' },
      { usage: '/levels multiplier add · remove · list', perm: 'Admin', description: 'Bonus (or reduced) XP in specific channels or for roles.' },
      { usage: '/levels givexp · takexp · resetxp', perm: 'Admin', description: "Reward, penalize or reset a member's XP." },
      { usage: '/levels xpconfig', perm: 'Admin', description: 'Tune XP per message, cooldown and level curve.' },
      { usage: '/levels announcechannel', perm: 'Admin', description: 'Where level-up messages are posted.' },
      { usage: '/levels cardaccess', perm: 'Admin', description: 'Make rank card customization a booster perk.' },
      { usage: '/levels toggle', perm: 'Admin', description: 'Turn XP gain on or off.' }
    ]
  },
  {
    id: 'gambling',
    group: 'XP Gambling',
    icon: '🎰',
    blurb: 'Bet XP on games of chance. Every game shows your updated balance.',
    tab: 'gambling',
    commands: [
      { usage: '/pot view · history · entrants', perm: null, description: "The Daily XP Pot: today's gambling losses, the top contributors, the draw time, who's entered (and who's close), and recent winners." },
      { usage: '/pot setup · look · toggle', perm: 'Manage Server', description: 'Where and when the pot is drawn, who counts as active, the top prize and number of winners, and how its embed looks.' },
      { usage: '/pot draw · preview', perm: 'Manage Server', description: "Post today's pot now and draw it after the countdown, or preview the embed." },
      { usage: '/gamble coinflip', perm: null, description: 'Heads or tails — win about double your bet.' },
      { usage: '/gamble dice', perm: null, description: 'Roll 0–100 under or over a target you pick — lower chance, bigger payout.' },
      { usage: '/gamble limbo', perm: null, description: 'Pick a target multiplier (1.01x–1000x); win it if the result reaches it.' },
      { usage: '/gamble blackjack', perm: null, description: 'Beat the dealer to 21 — hit, stand or double down.' },
      { usage: '/gamble mines', perm: null, description: '5×5 minefield: reveal gems, avoid mines, cash out any time.' },
      { usage: '/gamble highlow', perm: null, description: 'Call higher or lower to build a multiplier, then cash out.' },
      { usage: '/gamble stats', perm: null, description: 'Your games, win rate, net XP, biggest win and streaks — or the server’s top players.' },
      { usage: '/gamble info', perm: null, description: 'Payouts, limits, and how many plays and how much XP you have left today.' },
      { usage: '/gamble resume', perm: null, description: 'Dismissed your private game buttons? Get them back.' },
      { usage: '/gamble sync', perm: null, description: "Stuck? End your game now and get back XP from games that didn't finish (admins: everyone:true)." },
      { usage: '/gamble config', perm: 'Admin', description: 'Enable gambling; set the house edge, bet limits, daily plays, daily win limit and channel.' }
    ]
  },
  {
    id: 'alerts',
    group: 'Creator Alerts',
    icon: '📡',
    blurb: 'Twitch go-live and YouTube upload alerts with custom embeds and pings.',
    tab: 'alerts',
    commands: [
      { usage: '/alerts add', perm: 'Manage Server', description: 'Paste any twitch.tv or YouTube link to follow it and pick where alerts go.' },
      { usage: '/alerts list', perm: 'Manage Server', description: 'Every followed channel and whether it is live.' },
      { usage: '/alerts test', perm: 'Manage Server', description: 'Post a sample alert (no one is pinged).' },
      { usage: '/alerts remove', perm: 'Manage Server', description: 'Stop following a channel.' }
    ]
  },
  {
    id: 'honeypot',
    group: 'Honeypot',
    icon: '🍯',
    blurb: 'A trap channel that instantly removes raid bots and compromised accounts.',
    tab: 'honeypot',
    commands: [
      { usage: '/honeypot setup', perm: 'Admin', description: 'Turn a channel into the trap and post its message.' },
      { usage: '/honeypot action', perm: 'Admin', description: 'Choose the punishment: kick, soft ban or ban.' },
      { usage: '/honeypot embed', perm: 'Admin', description: 'Disguise the trap message (title, text, color, image).' },
      { usage: '/honeypot embed_reset', perm: 'Admin', description: 'Restore the default trap message.' },
      { usage: '/honeypot dm', perm: 'Admin', description: 'DM caught members why they were removed and how to secure their account.' },
      { usage: '/honeypot toggle', perm: 'Admin', description: 'Pause or resume the trap.' },
      { usage: '/honeypot status', perm: 'Admin', description: 'Current setup and catch counts.' }
    ]
  },
  {
    id: 'moderation',
    group: 'Moderation & Logs',
    icon: '🛡️',
    blurb: 'Warnings, timeouts, kicks and bans with a case history, plus logs, lockdowns and cleanup tools.',
    tab: 'moderation',
    commands: [
      { usage: '/automod toggle · rule', perm: 'Manage Server', description: 'Spam protection: floods, repeated messages, text walls, mass mentions, invites, unsafe/scam links (plus optional link and caps spam).' },
      { usage: '/automod links · checklink', perm: 'Manage Server', description: 'Link safety: block unsafe links only or allow only approved sites, approved/blocked lists, and test what happens to a link.' },
      { usage: '/automod punishment · exempt · status', perm: 'Manage Server', description: 'Warnings before the mute (default 2, then 1 hour), roles/channels that skip it, and recent catches.' },
      { usage: '/logs set', perm: 'Manage Server', description: 'Choose the channel that receives server logs.' },
      { usage: '/logs toggle', perm: 'Manage Server', description: 'Switch individual log types on or off — messages, members, bans, channels, roles, threads, invites, emoji, server settings, commands and more.' },
      { usage: '/logs enable · disable', perm: 'Manage Server', description: 'Turn the whole logging module on or off.' },
      { usage: '/logs status', perm: 'Manage Server', description: 'Show the logging setup.' },
      { usage: '/warn', perm: 'Timeout Members', description: 'Warn a member (DM’d with the reason; can trigger automatic escalation).' },
      { usage: '/timeout · /untimeout', perm: 'Timeout Members', description: 'Time a member out for up to 28 days, or lift it.' },
      { usage: '/kick', perm: 'Kick Members', description: 'Kick a member, with a reason recorded as a case.' },
      { usage: '/ban · /unban', perm: 'Ban Members', description: 'Ban (optionally temporarily, even by user ID) or unban.' },
      { usage: '/cases user · recent · view', perm: 'Timeout Members', description: 'Moderation history for a member or the whole server.' },
      { usage: '/cases reason · revoke · delete', perm: 'Timeout Members', description: 'Edit a case, revoke a warning, or delete a case.' },
      { usage: '/cases escalation add · remove · list', perm: 'Manage Server', description: 'Automatic timeout / kick / ban at N warnings.' },
      { usage: '/slowmode', perm: 'Manage Channels', description: 'Set or turn off a channel’s slowmode.' },
      { usage: '/lockdown', perm: 'Manage Channels', description: 'Stop non-staff from talking in a channel or the whole server.' },
      { usage: '/unlockdown', perm: 'Manage Channels', description: 'Lift a lockdown and restore the original permissions.' },
      { usage: '/purge', perm: 'Manage Messages', description: 'Bulk-delete recent messages, optionally from one user.' },
      { usage: '/mediaonly add · remove · list', perm: 'Manage Channels', description: 'Make channels media-only — text-only posts are removed; optional comment threads.' }
    ]
  },
  {
    id: 'shop',
    group: 'XP Shop',
    icon: '🛍️',
    blurb: 'Spend XP on fun extras — auto-reacts, XP boosts, extra gambles, nickname tags, custom badges, roles and collectibles.',
    tab: 'shop',
    commands: [
      { usage: '/shop view', perm: null, description: 'Browse the shop and buy something from a menu.' },
      { usage: '/shop buy', perm: null, description: 'Buy an item straight away (autocompletes). For the Nickname item, add name: to set your server nickname.' },
      { usage: '/shop inventory', perm: null, description: 'What you (or someone else) own.' },
      { usage: '/shop toggle', perm: null, description: 'Switch an item on or off — auto-react, nickname tag, badge, roles.' },
      { usage: '/shop customize', perm: null, description: 'Make it yours: your emoji, badge title and badge color.' }
    ]
  },
  {
    id: 'engagement',
    group: 'Engagement',
    icon: '✨',
    blurb: 'Birthdays, a counting game and a starboard — set them up once and they run themselves.',
    tab: 'engagement',
    commands: [
      { usage: '/birthday set · remove', perm: null, description: 'Save (or forget) your birthday — month and day, no year.' },
      { usage: '/birthday view · upcoming', perm: null, description: "Someone's birthday, or whose birthdays are coming up next." },
      { usage: '/birthday setup · toggle', perm: 'Manage Server', description: 'Where birthday wishes go, the post time, an optional role for the day and an XP gift.' },
      { usage: '/counting setup · toggle', perm: 'Manage Server', description: 'A counting game channel — ✅ for each right number, a wrong one resets. Full maths allowed (PEMDAS, 5!, √, nCr, ∑/∏/∫). Grief protection: numbers-only, double-counts deleted (not a reset), deletes/edits re-posted, and slowmode.' },
      { usage: '/counting set · status', perm: 'Manage Server', description: 'Fix the count after an unfair reset, or see the next number, best run, settings and resets.' },
      { usage: '/starboard setup · toggle', perm: 'Manage Server', description: 'Repost messages that get enough ⭐ (or your emoji) in a starboard channel.' },
      { usage: '/starboard ignore · top', perm: 'Manage Server', description: "Keep a channel off the starboard, or see the most-starred messages." }
    ]
  },
  {
    id: 'tickets',
    group: 'Tickets',
    icon: '🎫',
    blurb: 'Private support channels opened from a panel button, with claim, ping, transcripts and DM on close.',
    tab: 'tickets',
    commands: [
      { usage: '/ticket setup', perm: 'Manage Server', description: 'Pick the panel channel, category, support roles, names and look — then post the panel.' },
      { usage: '/ticket panel', perm: 'Manage Server', description: 'Re-post the ticket panel (or update it after changes).' },
      { usage: '/ticket toggle', perm: 'Manage Server', description: 'Turn the ticket system on or off.' },
      { usage: '/ticket close', perm: null, description: 'Close the ticket you’re in (the member who opened it or support), with an optional reason.' },
      { usage: '/ticket claim', perm: 'Support', description: 'Claim a ticket so others know you’re on it (again to unclaim).' },
      { usage: '/ticket add · remove', perm: 'Support', description: 'Let another member see a ticket, or remove them.' },
      { usage: '/ticket rename', perm: 'Support', description: 'Rename the ticket channel.' },
      { usage: '/ticket list', perm: 'Support', description: 'All open tickets, who opened them and who claimed them.' }
    ]
  },
  {
    id: 'roles',
    group: 'Roles',
    icon: '🎭',
    blurb: 'Automatic and self-assignable roles.',
    tab: 'reactionroles',
    commands: [
      { usage: '/autorole set', perm: 'Manage Roles', description: 'Role every new member gets on join.' },
      { usage: '/autorole sync', perm: 'Manage Roles', description: 'Give the auto-role to existing members missing it.' },
      { usage: '/autorole status · disable', perm: 'Manage Roles', description: 'Check or turn off auto-role.' },
      { usage: '/reactionrole create', perm: 'Manage Roles', description: 'Post a self-assign role panel (buttons or dropdown).' },
      { usage: '/reactionrole add · remove', perm: 'Manage Roles', description: 'Add or remove roles on a panel.' },
      { usage: '/reactionrole list · delete', perm: 'Manage Roles', description: 'List or delete role panels.' }
    ]
  },
  {
    id: 'welcome',
    group: 'Welcome & Goodbye',
    icon: '👋',
    blurb: 'Greet people who join and say goodbye to people who leave.',
    tab: 'welcome',
    commands: [
      { usage: '/welcome set · toggle · test · show', perm: 'Manage Server', description: 'Welcome channel and message, on/off, a test post and the current setup.' },
      { usage: '/goodbye set · toggle · test · show', perm: 'Manage Server', description: 'The same for goodbye messages when someone leaves.' }
    ]
  },
  {
    id: 'community',
    group: 'Community',
    icon: '💬',
    blurb: 'Polls and reminders for everyone.',
    tab: 'community',
    commands: [
      { usage: '/poll create', perm: null, description: 'Button poll — public or anonymous, with an optional timer.' },
      { usage: '/poll end', perm: null, description: 'Close a poll early (creator or moderators).' },
      { usage: '/remind me', perm: null, description: 'DM yourself a reminder, e.g. in 2h or 1d12h.' },
      { usage: '/remind channel', perm: null, description: 'Post a reminder in a channel.' },
      { usage: '/remind list · cancel', perm: null, description: 'See or cancel your reminders.' },
      { usage: '/music play · skip · stop', perm: null, description: 'Play Lofi / chill radio in your voice channel, switch stations, or stop. Light, free, ToS-safe.' },
      { usage: '/music stations · nowplaying · volume', perm: null, description: 'Browse stations, see what’s playing, or set the volume.' },
      { usage: '/music config', perm: 'Manage Server', description: 'Turn music on/off, set a DJ role and default volume (full setup — channels & stations — on the dashboard).' }
    ]
  },
  {
    id: 'info',
    group: 'Info & Utility',
    icon: 'ℹ️',
    blurb: 'Lookups and bot info.',
    tab: null,
    commands: [
      { usage: '/loof help', perm: null, description: 'This help menu.' },
      { usage: '/loof ping', perm: null, description: "Bot latency." },
      { usage: '/serverinfo', perm: null, description: 'Server stats: members, boosts, channels and more.' },
      { usage: '/serverstats setup · stat · refresh · remove', perm: 'Manage Server', description: 'View-only channels pinned at the top of the server showing live counts (members, online, boosts, top XP, roles, channels), refreshed every ~30 min.' },
      { usage: '/userinfo', perm: null, description: "A member's account age, join date and roles." },
      { usage: '/avatar', perm: null, description: "Someone's full-size avatar." }
    ]
  }
];

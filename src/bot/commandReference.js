// Single source of truth for every slash command, grouped the same way as the dashboard.
// Used by /loof help, the dashboard's Commands page and its search bar — kept separate from the
// SlashCommandBuilder definitions so the web side doesn't import discord.js command internals.
//
// perm: who can use it (null = everyone). tab: the dashboard page for that module, if any.
module.exports = [
  {
    id: 'giveaways',
    group: 'Giveaways',
    icon: '🎁',
    blurb: 'Timed giveaways and first-to-click drops, with optional entry requirements.',
    tab: null,
    commands: [
      { usage: '/loof start', perm: 'Admin', description: 'Start a giveaway right away with inline options (requirements included).' },
      { usage: '/loof create', perm: 'Admin', description: 'Set up a giveaway step by step in a popup form.' },
      { usage: '/loof drop', perm: 'Admin', description: 'First-to-click drop — the first N people to press Claim win instantly.' },
      { usage: '/loof requirements', perm: 'Admin', description: 'Require a role, days in the server, or an XP level to enter.' },
      { usage: '/loof edit', perm: 'Admin', description: 'Change the prize or winner count of a running giveaway.' },
      { usage: '/loof end', perm: 'Admin', description: 'End a giveaway early and draw winners now.' },
      { usage: '/loof reroll', perm: 'Admin', description: 'Draw a new winner for an ended giveaway.' },
      { usage: '/loof delete', perm: 'Admin', description: 'Delete a giveaway and its message.' },
      { usage: '/loof list', perm: 'Admin', description: 'List every giveaway running in this server.' }
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
      { usage: '/gamble coinflip', perm: null, description: 'Heads or tails — win about double your bet.' },
      { usage: '/gamble blackjack', perm: null, description: 'Beat the dealer to 21 — hit, stand or double down.' },
      { usage: '/gamble mines', perm: null, description: '5×5 minefield: reveal gems, avoid mines, cash out any time.' },
      { usage: '/gamble highlow', perm: null, description: 'Call higher or lower to build a multiplier, then cash out.' },
      { usage: '/gamble info', perm: null, description: 'Payouts, house edge and bet limits.' },
      { usage: '/gamble config', perm: 'Admin', description: 'Enable gambling, set the house edge, limits and channel.' }
    ]
  },
  {
    id: 'alerts',
    group: 'Creator Alerts',
    icon: '📡',
    blurb: 'Twitch go-live and YouTube upload alerts with custom embeds and pings.',
    tab: 'alerts',
    commands: [
      { usage: '/alerts add', perm: 'Manage Server', description: 'Follow a Twitch or YouTube channel and pick where alerts go.' },
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
    blurb: 'Server logs, lockdowns and cleanup tools.',
    tab: 'logs',
    commands: [
      { usage: '/logs set', perm: 'Manage Server', description: 'Choose the channel that receives server logs.' },
      { usage: '/logs toggle', perm: 'Manage Server', description: 'Switch individual log types on or off.' },
      { usage: '/logs enable · disable', perm: 'Manage Server', description: 'Turn the whole logging module on or off.' },
      { usage: '/logs status', perm: 'Manage Server', description: 'Show the logging setup.' },
      { usage: '/lockdown', perm: 'Manage Channels', description: 'Stop non-staff from talking in a channel or the whole server.' },
      { usage: '/unlockdown', perm: 'Manage Channels', description: 'Lift a lockdown and restore the original permissions.' },
      { usage: '/purge', perm: 'Manage Messages', description: 'Bulk-delete recent messages, optionally from one user.' }
    ]
  },
  {
    id: 'roles',
    group: 'Roles',
    icon: '🎭',
    blurb: 'Automatic and self-assignable roles.',
    tab: 'autorole',
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
    id: 'community',
    group: 'Community',
    icon: '💬',
    blurb: 'Polls and reminders for everyone.',
    tab: null,
    commands: [
      { usage: '/poll create', perm: null, description: 'Button poll — public or anonymous, with an optional timer.' },
      { usage: '/poll end', perm: null, description: 'Close a poll early (creator or moderators).' },
      { usage: '/remind me', perm: null, description: 'DM yourself a reminder, e.g. in 2h or 1d12h.' },
      { usage: '/remind channel', perm: null, description: 'Post a reminder in a channel.' },
      { usage: '/remind list · cancel', perm: null, description: 'See or cancel your reminders.' }
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
      { usage: '/userinfo', perm: null, description: "A member's account age, join date and roles." },
      { usage: '/avatar', perm: null, description: "Someone's full-size avatar." }
    ]
  }
];

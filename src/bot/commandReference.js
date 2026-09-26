// Central place describing every slash command — kept separate from the SlashCommandBuilder
// definitions so the web dashboard can render a friendly command reference without importing
// discord.js command-building internals.
module.exports = [
  {
    group: 'Giveaways',
    commands: [
      { usage: '/loof start', description: 'Start a giveaway immediately with inline options.' },
      { usage: '/loof create', description: 'Open a popup modal to configure a giveaway interactively.' },
      { usage: '/loof drop', description: 'First-to-click drop — the first N people to press Claim win instantly.' },
      { usage: '/loof requirements', description: 'Require a role, minimum days in the server, or an XP level to enter.' },
      { usage: '/loof end', description: 'End an active giveaway early and draw winners.' },
      { usage: '/loof reroll', description: 'Pick a new winner from an already-ended giveaway.' },
      { usage: '/loof delete', description: "Delete a giveaway's message and remove its data." },
      { usage: '/loof list', description: 'List all currently active giveaways in this server.' },
      { usage: '/loof edit', description: 'Update the prize or winner count on a live giveaway.' },
      { usage: '/loof ping', description: "Check the bot's API and WebSocket latency." },
      { usage: '/loof help', description: 'Show the in-Discord help embed.' }
    ]
  },
  {
    group: 'Honeypot (Admin only)',
    commands: [
      { usage: '/honeypot setup', description: 'Designate a channel as the trap and post the live counter.' },
      { usage: '/honeypot action', description: 'Set the punishment: kick, soft ban, or permanent ban.' },
      { usage: '/honeypot status', description: 'Show the current honeypot configuration and counts.' },
      { usage: '/honeypot embed', description: 'Customize/disguise the trap message (title, text, color, image, counters).' },
      { usage: '/honeypot embed_reset', description: 'Restore the default trap message.' }
    ]
  },
  {
    group: 'Leveling',
    commands: [
      { usage: '/levels rank', description: "Check your (or someone else's) level, XP, and server rank." },
      { usage: '/levels leaderboard', description: 'Show the XP leaderboard, with optional page number.' },
      { usage: '/levels setrole (Admin)', description: 'Grant a role automatically at a given level.' },
      { usage: '/levels removerole (Admin)', description: 'Remove a level-up role reward.' },
      { usage: '/levels toggle (Admin)', description: 'Turn XP gain on or off for this server.' },
      { usage: '/levels announcechannel (Admin)', description: 'Send level-up messages to a specific channel, or leave empty for the same channel.' },
      { usage: '/levels multiplier add|remove|list (Admin)', description: 'Bonus (or reduced) XP for specific channels or roles.' },
      { usage: '/levels givexp · takexp · resetxp (Admin)', description: "Manually reward, penalize, or reset a member's XP." },
      { usage: '/levels card', description: 'Customize your rank card color, background image, and tagline.' },
      { usage: '/levels cardaccess (Admin)', description: 'Limit rank card customization to server boosters.' },
      { usage: '/levels xpconfig (Admin)', description: 'Tune XP-per-message, cooldown, and leveling speed.' },
      { usage: '/levels xpconfig_show', description: 'Show the current XP tuning for this server.' }
    ]
  },
  {
    group: 'Auto-Role (Admin only)',
    commands: [
      { usage: '/autorole set', description: 'Choose the role granted automatically to new members.' },
      { usage: '/autorole disable', description: 'Turn off auto-role assignment.' },
      { usage: '/autorole status', description: 'Show the current auto-role configuration.' },
      { usage: '/autorole sync', description: 'Retroactively grant the role to every existing member missing it.' }
    ]
  },
  {
    group: 'Utility & Moderation',
    commands: [
      { usage: '/serverinfo', description: "Show this server's stats: members, boosts, channels, roles, and more." },
      { usage: '/userinfo', description: "Show a member's account creation date, join date, and roles." },
      { usage: '/avatar', description: "Show a user's full-size avatar." },
      { usage: '/purge (Manage Messages)', description: 'Bulk-delete recent messages, optionally filtered by user.' }
    ]
  },
  {
    group: 'XP Gambling',
    commands: [
      { usage: '/gamble coinflip', description: 'Bet XP on heads or tails — win roughly double.' },
      { usage: '/gamble mines', description: '5x5 minefield: reveal gems, avoid mines, cash out any time. More mines = bigger multipliers.' },
      { usage: '/gamble highlow', description: 'Call higher or lower on the next card to build a multiplier, then cash out.' },
      { usage: '/gamble info', description: 'Show payouts, the house edge, and bet limits.' },
      { usage: '/gamble config (Admin)', description: 'Enable/disable gambling, set the house edge, bet limits, and channel.' }
    ]
  },
  {
    group: 'Moderation & Security',
    commands: [
      { usage: '/logs set · toggle · disable · status', description: 'Log message edits/deletes, joins/leaves, voice activity, and role changes.' },
      { usage: '/lockdown', description: 'Stop non-staff from sending messages in one channel or the whole server.' },
      { usage: '/unlockdown', description: 'Lift a lockdown and restore the original channel permissions.' }
    ]
  },
  {
    group: 'Community Tools',
    commands: [
      { usage: '/reactionrole create · add · remove · delete · list', description: 'Self-assignable role panels using buttons or dropdowns.' },
      { usage: '/poll create', description: 'Button poll with public or anonymous voting and an optional auto-close timer.' },
      { usage: '/poll end', description: 'Close a poll early (creator or moderators).' },
      { usage: '/remind me · channel · list · cancel', description: 'DM or channel reminders, e.g. in 2h or 1d12h.' }
    ]
  }
];

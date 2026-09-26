// Central place describing every slash command — kept separate from the SlashCommandBuilder
// definitions so the web dashboard can render a friendly command reference without importing
// discord.js command-building internals.
module.exports = [
  {
    group: 'Giveaways',
    commands: [
      { usage: '/loof start', description: 'Start a giveaway immediately with inline options.' },
      { usage: '/loof create', description: 'Open a popup modal to configure a giveaway interactively.' },
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
      { usage: '/honeypot status', description: 'Show the current honeypot configuration and counts.' }
    ]
  },
  {
    group: 'Leveling',
    commands: [
      { usage: '/levels rank', description: "Check your (or someone else's) level, XP, and server rank." },
      { usage: '/levels leaderboard', description: 'Show the top 10 members by XP.' },
      { usage: '/levels setrole (Admin)', description: 'Grant a role automatically at a given level.' },
      { usage: '/levels removerole (Admin)', description: 'Remove a level-up role reward.' },
      { usage: '/levels toggle (Admin)', description: 'Turn XP gain on or off for this server.' },
      { usage: '/levels xpconfig (Admin)', description: 'Tune XP-per-message, cooldown, and leveling speed.' },
      { usage: '/levels xpconfig_show', description: 'Show the current XP tuning for this server.' }
    ]
  }
];

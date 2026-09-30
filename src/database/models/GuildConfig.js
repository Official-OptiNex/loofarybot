const mongoose = require('mongoose');

const LevelRoleSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    roleId: { type: String, required: true }
  },
  { _id: false }
);

// One color tier. Auto tiers point at a role the bot created (roleId filled in lazily);
// custom tiers point at an existing role an admin chose instead.
const LevelColorTierSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    roleId: { type: String, default: null },
    custom: { type: Boolean, default: false },
    color: { type: String, default: null } // override for auto roles; null = palette color
  },
  { _id: false }
);

const XpMultiplierSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['channel', 'role'], required: true },
    targetId: { type: String, required: true },
    multiplier: { type: Number, required: true }
  },
  { _id: false }
);

// One saved permission overwrite per (channel, role) touched by /lockdown, so /unlockdown
// can put each permission back exactly how it was instead of blindly clearing it.
const LockdownOverwriteSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true },
    targetId: { type: String, required: true },
    hadOverwrite: { type: Boolean, default: false },
    prevAllow: { type: [String], default: [] },
    prevDeny: { type: [String], default: [] }
  },
  { _id: false }
);

const GuildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    // --- Honeypot ---
    honeypotChannelId: { type: String, default: null },
    honeypotAction: {
      type: String,
      enum: ['kick', 'softban', 'ban'],
      default: 'kick'
    },
    honeypotCounterMessageId: { type: String, default: null },
    honeypotKicks: { type: Number, default: 0 },
    honeypotSoftbans: { type: Number, default: 0 },
    honeypotBans: { type: Number, default: 0 },
    honeypotEnabled: { type: Boolean, default: true },
    honeypotDmEnabled: { type: Boolean, default: true }, // explain the removal to the member by DM
    // Customizable look of the trap message so it can be disguised as something innocent.
    honeypotEmbed: {
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      color: { type: String, default: '' },
      footer: { type: String, default: '' },
      imageUrl: { type: String, default: '' },
      thumbnailUrl: { type: String, default: '' },
      showCounts: { type: Boolean, default: true }
    },

    // --- Leveling ---
    levelingEnabled: { type: Boolean, default: true },
    levelRoles: { type: [LevelRoleSchema], default: [] },
    // Per-guild overrides. null/undefined means "use the global default from config.js".
    xpMin: { type: Number, default: null },
    xpMax: { type: Number, default: null },
    xpCooldownSeconds: { type: Number, default: null },
    levelXpBase: { type: Number, default: null },
    // Where level-up announcements go. null means "the same channel the user was chatting in".
    levelUpChannelId: { type: String, default: null },
    xpMultipliers: { type: [XpMultiplierSchema], default: [] },
    rankCardBoosterOnly: { type: Boolean, default: false },
    // /daily streak rewards. XP = base + min(bonusPerDay × (streak − 1), maxBonus) (+ milestone bonus).
    daily: {
      enabled: { type: Boolean, default: true },
      baseXp: { type: Number, default: 50 },
      bonusPerDay: { type: Number, default: 10 },
      maxBonus: { type: Number, default: 200 },
      milestoneEvery: { type: Number, default: 7 },
      milestoneBonus: { type: Number, default: 250 }
    },
    // Cosmetic name-color roles: members hold the color role for the highest tier they've reached.
    levelColors: {
      enabled: { type: Boolean, default: false },
      interval: { type: Number, default: 5 },
      maxLevel: { type: Number, default: 100 },
      // low = just above @everyone · high = just below LoofaryBot's own role · above = above anchorRoleId
      placement: { type: String, enum: ['low', 'high', 'above'], default: 'low' },
      anchorRoleId: { type: String, default: null },
      tiers: { type: [LevelColorTierSchema], default: [] }
    },

    // --- XP Gambling ---
    gamblingEnabled: { type: Boolean, default: true },
    gamblingHouseEdge: { type: Number, default: 4 }, // percent
    gamblingMinBet: { type: Number, default: 10 },
    gamblingMaxBet: { type: Number, default: null }, // null = no cap
    gamblingMaxWin: { type: Number, default: null }, // most XP profit from one game; null = no cap
    gamblingDailyLimit: { type: Number, default: 10 }, // games per member per UTC day; 0 = unlimited
    gamblingDailyWinCap: { type: Number, default: 1000 }, // most XP a member can come out ahead per UTC day; 0 = no cap
    boosterPerks: {
      enabled: { type: Boolean, default: true },
      extraGambles: { type: Number, default: 5 }, // added to the daily gamble limit
      giveawayEntries: { type: Number, default: 2 }, // extra tickets in every timed giveaway
      dailyXp: { type: Number, default: 100 }, // automatic daily XP drop
      boostXp: { type: Number, default: 500 }, // one-time thank-you package when someone boosts
      channelId: { type: String, default: null } // where drops and thank-yous are announced (optional)
    },
    boosterDropDay: { type: String, default: null }, // UTC day the last daily booster drop went out
    // Random XP drops in chat (/xpdrop or dashboard Leveling → Chat drops).
    chatDrops: {
      enabled: { type: Boolean, default: false },
      channelIds: { type: [String], default: [] },
      minXp: { type: Number, default: 50 },
      maxXp: { type: Number, default: 250 },
      minMinutes: { type: Number, default: 30 }, // time between drops is random in this range
      maxMinutes: { type: Number, default: 90 },
      minActivity: { type: Number, default: 3 }, // messages in the last 10 minutes before a channel gets a drop
      claimSeconds: { type: Number, default: 120 }, // how long a drop stays claimable
      nextDropAt: { type: Date, default: null },
      lastDropAt: { type: Date, default: null }
    },
    // Birthdays (/birthday, dashboard Engagement → Birthdays): one post a day, at announceHour UTC.
    birthdays: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      roleId: { type: String, default: null }, // given for the day, removed the next day
      xpGift: { type: Number, default: 0 },
      announceHour: { type: Number, default: 14 }, // UTC
      message: { type: String, default: '🎂 Happy birthday {users}! Have an amazing day! 🎉' },
      lastRunDay: { type: String, default: null } // 'YYYY-MM-DD' of the last announcement (so restarts don't repeat it)
    },
    // Counting game (/counting, dashboard Engagement → Counting).
    counting: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      current: { type: Number, default: 0 },
      lastUserId: { type: String, default: null },
      lastMessageId: { type: String, default: null },
      lastCountAt: { type: Date, default: null },
      record: { type: Number, default: 0 },
      bestBefore: { type: Number, default: 0 }, // best run before the current one (for the 🏆 when it's beaten)
      allowSameUser: { type: Boolean, default: false }, // false = people have to take turns
      mathAllowed: { type: Boolean, default: true }, // "2*5" counts as 10
      resets: { type: Number, default: 0 },
      lastResetBy: { type: String, default: null }
    },
    // Starboard (/starboard, dashboard Engagement → Starboard).
    starboard: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      emoji: { type: String, default: '⭐' },
      threshold: { type: Number, default: 3 },
      selfStar: { type: Boolean, default: false },
      ignoredChannelIds: { type: [String], default: [] }
    },
    // Daily XP Pot (/pot, dashboard Gambling → Daily XP Pot): gambling losses fill a pot that one
    // member who chatted in the last hour before the draw wins.
    xpPot: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      drawHour: { type: Number, default: 0 }, // UTC hour the pot is drawn (0 = midnight, the end of the day)
      countdownMinutes: { type: Number, default: 10 }, // the pot is posted this long before the draw
      windowMinutes: { type: Number, default: 60 }, // "active" = chatted in this window before the draw
      minMessages: { type: Number, default: 3 },
      sharePercent: { type: Number, default: 100 }, // share of each gambling loss that goes into the pot
      minPot: { type: Number, default: 100 }, // smaller pots roll over to tomorrow
      maxPrize: { type: Number, default: 3000 }, // 1st place's prize is capped here; each place after gets ≤70% of the one above
      maxWinners: { type: Number, default: 10 }, // what doesn't fit these places rolls over to tomorrow
      maxPot: { type: Number, default: 10000 }, // the pot never holds more; when it's full it's drawn right away
      pingRoleId: { type: String, default: null },
      embed: {
        title: { type: String, default: '💰 Daily XP Pot' },
        description: { type: String, default: null }, // null = the built-in "how it works" text
        color: { type: String, default: '#F1C40F' },
        thumbnailUrl: { type: String, default: null },
        imageUrl: { type: String, default: null },
        footer: { type: String, default: 'Losses today = someone’s win tonight' }
      },
      winMessage: { type: String, default: null } // null = the built-in message listing every winner
    },
    gamblingChannelId: { type: String, default: null }, // null = any channel
    // Safety net: a player who gambles below the minimum bet gets one free bet (at most once per cooldown).
    gamblingFreePlayEnabled: { type: Boolean, default: true },
    gamblingFreePlayAmount: { type: Number, default: 300 },
    gamblingFreePlayCooldownHours: { type: Number, default: 24 },

    // --- Logging ---
    logsEnabled: { type: Boolean, default: true },
    // Staff channel for bot problems (missing permissions, failed role changes, errors).
    alertsChannelId: { type: String, default: null },

    // --- Go-live / upload alerts (subscriptions live in AlertSubscription) ---
    socialAlertsEnabled: { type: Boolean, default: true },

    // --- Dashboard access for moderators (admins always have full access) ---
    dashboardAccess: {
      modRoleIds: { type: [String], default: [] },
      modPages: { type: [String], default: ['leaderboard', 'commands', 'logviewer'] }
    },
    // Auto-mod (Moderation → Auto-mod, /automod). Each rule deletes the messages and gives a strike:
    // strikes 1..warnings are warnings, the next one is a timeout.
    automod: {
      enabled: { type: Boolean, default: false },
      flood: { enabled: { type: Boolean, default: true }, messages: { type: Number, default: 7 }, seconds: { type: Number, default: 5 } },
      duplicates: { enabled: { type: Boolean, default: true }, count: { type: Number, default: 4 }, seconds: { type: Number, default: 30 } },
      walls: { enabled: { type: Boolean, default: true }, maxLines: { type: Number, default: 30 } },
      mentions: { enabled: { type: Boolean, default: true }, max: { type: Number, default: 5 }, everyone: { type: Boolean, default: true } },
      invites: { enabled: { type: Boolean, default: true } },
      links: { enabled: { type: Boolean, default: false }, max: { type: Number, default: 4 } },
      caps: { enabled: { type: Boolean, default: false }, percent: { type: Number, default: 80 }, minLength: { type: Number, default: 15 } },
      warnings: { type: Number, default: 2 }, // warnings before the timeout
      muteMinutes: { type: Number, default: 60 },
      strikeResetHours: { type: Number, default: 24 }, // strikes older than this are forgotten
      notify: { type: Boolean, default: true }, // short in-channel notice (deleted after a few seconds)
      exemptRoleIds: { type: [String], default: [] },
      exemptChannelIds: { type: [String], default: [] }
    },
    logRetentionDays: { type: Number, default: 30 }, // dashboard log viewer history
    shopEnabled: { type: Boolean, default: true }, // XP shop (/shop, dashboard XP Shop)
    shopSeeded: { type: Boolean, default: false }, // the starter items were added once
    logChannelId: { type: String, default: null },
    logEvents: {
      messageEdit: { type: Boolean, default: true },
      messageDelete: { type: Boolean, default: true },
      memberJoin: { type: Boolean, default: true },
      memberLeave: { type: Boolean, default: true },
      voice: { type: Boolean, default: true },
      roles: { type: Boolean, default: true },
      modActions: { type: Boolean, default: true },
      automod: { type: Boolean, default: true },
      bulkDelete: { type: Boolean, default: true },
      members: { type: Boolean, default: true },
      bans: { type: Boolean, default: true },
      channels: { type: Boolean, default: true },
      serverRoles: { type: Boolean, default: true },
      threads: { type: Boolean, default: true },
      invites: { type: Boolean, default: true },
      emojis: { type: Boolean, default: true },
      server: { type: Boolean, default: true },
      commands: { type: Boolean, default: true },
      shop: { type: Boolean, default: true }
    },

    // --- Moderation cases ---
    caseCounter: { type: Number, default: 0 },
    // Warning escalation: when a member reaches `count` active warnings, this action runs automatically.
    warnEscalation: {
      type: [
        new mongoose.Schema(
          {
            count: { type: Number, required: true },
            action: { type: String, enum: ['timeout', 'kick', 'ban'], required: true },
            durationMs: { type: Number, default: null } // timeouts (and temporary bans)
          },
          { _id: false }
        )
      ],
      default: []
    },
    modDmEnabled: { type: Boolean, default: true }, // DM members when they're warned / timed out / kicked / banned

    // --- Lockdown ---
    lockdownOverwrites: { type: [LockdownOverwriteSchema], default: [] },

    // --- Media-only channels: posts without an attachment (or link, if allowed) are removed ---
    mediaOnlyChannels: {
      type: [
        new mongoose.Schema(
          {
            channelId: { type: String, required: true },
            allowLinks: { type: Boolean, default: true }, // links count as media (YouTube, Tenor, image URLs…)
            autoThread: { type: Boolean, default: false }, // open a comment thread on every post
            staffBypass: { type: Boolean, default: true } // Manage Messages members can post anything
          },
          { _id: false }
        )
      ],
      default: []
    },

    // --- Auto-Role ---
    autoRoleId: { type: String, default: null },
    autoRoleEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Any write clears the short settings cache for that server (database/configCache.js).
const { invalidate } = require('../configCache');
GuildConfigSchema.post('save', (doc) => invalidate(doc.guildId));
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  GuildConfigSchema.pre(op, function clearConfigCache() {
    invalidate(this.getFilter?.().guildId);
  });
  GuildConfigSchema.post(op, function clearConfigCacheAfter() {
    invalidate(this.getFilter?.().guildId); // again, in case a read refilled it mid-write
  });
}

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);

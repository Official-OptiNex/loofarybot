const mongoose = require('mongoose');

// One followed Twitch channel or YouTube channel, and how its alert looks in one Discord channel.
const AlertSubscriptionSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    platform: { type: String, enum: ['twitch', 'youtube'], required: true },
    account: { type: String, required: true }, // twitch login (lowercase) or YouTube channel id (UC…)
    displayName: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    channelId: { type: String, required: true }, // Discord channel to post in
    pingRoleId: { type: String, default: null }, // guild id = @everyone
    enabled: { type: Boolean, default: true },
    message: { type: String, default: '' },
    embed: {
      enabled: { type: Boolean, default: true },
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      color: { type: String, default: '' },
      showImage: { type: Boolean, default: true }
    },
    state: {
      live: { type: Boolean, default: false },
      streamId: { type: String, default: null },
      liveMessageId: { type: String, default: null },
      liveStartedAt: { type: Date, default: null },
      lastVideoPublished: { type: Date, default: null },
      seenVideoIds: { type: [String], default: [] }
    }
  },
  { timestamps: true }
);

AlertSubscriptionSchema.index({ platform: 1, account: 1 });

module.exports = mongoose.model('AlertSubscription', AlertSubscriptionSchema);

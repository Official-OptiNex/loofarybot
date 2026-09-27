const mongoose = require('mongoose');

const WelcomeConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    channelId: { type: String, default: null },
    // Supports {user}, {username}, {server} and {membercount} placeholders.
    messageContent: { type: String, default: 'Welcome to **{server}**, {user}! You are member #{membercount}.' },
    embedEnabled: { type: Boolean, default: false },
    embedConfig: {
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      color: { type: String, default: '#5865F2' },
      imageUrl: { type: String, default: '' },
      thumbnailUrl: { type: String, default: '' },
      footer: { type: String, default: '' }
    },
    // Goodbye message when someone leaves (same placeholders; nobody is pinged).
    goodbye: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      messageContent: { type: String, default: '👋 **{username}** left **{server}**. We now have {membercount} members.' },
      embedEnabled: { type: Boolean, default: false },
      embedConfig: {
        title: { type: String, default: '' },
        description: { type: String, default: '' },
        color: { type: String, default: '#ED4245' },
        imageUrl: { type: String, default: '' },
        thumbnailUrl: { type: String, default: '' },
        footer: { type: String, default: '' }
      }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('WelcomeConfig', WelcomeConfigSchema);

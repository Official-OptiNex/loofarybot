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
    // "New here?" message: a button on the welcome message (and optionally a panel in any channel) that
    // shows the pressing member a private "Only you can see this" message. `message` is Discord message
    // JSON ({ content, embeds: [...] }, up to 10 embeds) with the welcome placeholders; null = the starter.
    newMember: {
      enabled: { type: Boolean, default: false },
      onWelcome: { type: Boolean, default: true }, // add the button to the welcome message
      buttonLabel: { type: String, default: 'New here? Click me' },
      buttonEmoji: { type: String, default: '👋' },
      buttonStyle: { type: String, enum: ['Primary', 'Secondary', 'Success', 'Danger'], default: 'Primary' },
      message: { type: mongoose.Schema.Types.Mixed, default: null },
      // The optional panel: its own message (Discord JSON) with the same button, posted in panelChannelId.
      panelChannelId: { type: String, default: null },
      panelMessageId: { type: String, default: null },
      panel: { type: mongoose.Schema.Types.Mixed, default: null }
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

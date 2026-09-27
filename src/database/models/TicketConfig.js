const mongoose = require('mongoose');

// One per server: how the ticket system looks and behaves (/ticket setup or the dashboard's Tickets page).
const TicketConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: true },

    // Where the "Open a ticket" panel lives.
    panelChannelId: { type: String, default: null },
    panelMessageId: { type: String, default: null },

    // Where ticket channels are created, and who can see them (admins always can).
    categoryId: { type: String, default: null },
    supportRoleIds: { type: [String], default: [] },
    nameFormat: { type: String, default: 'ticket-{number}' }, // {number} {username}
    maxOpenPerUser: { type: Number, default: 1 }, // 0 = unlimited
    askReason: { type: Boolean, default: false }, // ask "what do you need help with?" before opening
    pingSupport: { type: Boolean, default: true }, // mention the support roles in new tickets
    welcomeMessage: {
      type: String,
      default: 'Hi {user}! Thanks for reaching out — the support team will be with you shortly.\nPlease describe what you need help with.'
    },

    // The panel embed and its button.
    panel: {
      title: { type: String, default: '🎫 Need help?' },
      description: { type: String, default: 'Click the button below to open a private ticket with the support team.' },
      color: { type: String, default: '#5865F2' },
      thumbnailUrl: { type: String, default: null },
      imageUrl: { type: String, default: null }, // banner
      footer: { type: String, default: null }
    },
    button: {
      label: { type: String, default: 'Open a ticket' },
      style: { type: String, enum: ['Primary', 'Success', 'Secondary', 'Danger'], default: 'Primary' },
      emoji: { type: String, default: '🎫' }
    },

    // Closing.
    dmOnClose: { type: Boolean, default: true },
    closeDelaySeconds: { type: Number, default: 5 }, // countdown before the channel is deleted
    logChannelId: { type: String, default: null }, // close summaries + transcript files
    saveTranscripts: { type: Boolean, default: true },

    counter: { type: Number, default: 0 } // last ticket number handed out
  },
  { timestamps: true }
);

module.exports = mongoose.model('TicketConfig', TicketConfigSchema);

const mongoose = require('mongoose');

const PanelRoleSchema = new mongoose.Schema(
  {
    roleId: { type: String, required: true },
    label: { type: String, default: null },
    emoji: { type: String, default: null }
  },
  { _id: false }
);

const ReactionRolePanelSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    color: { type: String, default: '#5865F2' },
    // buttons = one toggle button per role; select = multi-pick dropdown; select_single = pick one.
    mode: { type: String, enum: ['buttons', 'select', 'select_single'], default: 'buttons' },
    roles: { type: [PanelRoleSchema], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReactionRolePanel', ReactionRolePanelSchema);

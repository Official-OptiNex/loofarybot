const mongoose = require('mongoose');

// Something members can buy with XP in one server's shop (/shop, dashboard XP Shop).
const ShopItemSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    key: { type: String, default: null }, // built-in items: 'autoreact', 'xpboost', … (null for custom ones)
    type: {
      type: String,
      enum: ['autoReact', 'xpBoost', 'extraGambles', 'nickTag', 'nickname', 'badge', 'role', 'collectible'],
      required: true
    },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    emoji: { type: String, default: '🛍️' },
    price: { type: Number, required: true, min: 0 },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    stock: { type: Number, default: null }, // null = unlimited
    sold: { type: Number, default: 0 },
    maxPerUser: { type: Number, default: 1 }, // 0 = no limit (consumables)
    minLevel: { type: Number, default: 0 },
    // Type-specific: roleId, durationHours, multiplier, plays, cooldownSeconds, reactEmoji.
    config: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShopItem', ShopItemSchema);

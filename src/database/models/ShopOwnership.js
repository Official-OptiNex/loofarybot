const mongoose = require('mongoose');

// What a member bought: one record per member per item (repeat buys add to quantity / extend time).
const ShopOwnershipSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    itemId: { type: String, required: true },
    type: { type: String, required: true },
    active: { type: Boolean, default: true }, // toggled on/off by the member (or ended when it expires)
    quantity: { type: Number, default: 1 },
    spent: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null }, // XP boosts and temporary roles
    // The member's own touches: emoji for auto-react / nickname tag; text + emoji + color for badges.
    custom: {
      emoji: { type: String, default: null },
      text: { type: String, default: null },
      color: { type: String, default: null },
      originalNick: { type: String, default: null }
    }
  },
  { timestamps: true }
);

ShopOwnershipSchema.index({ guildId: 1, userId: 1, itemId: 1 }, { unique: true });
ShopOwnershipSchema.index({ guildId: 1, type: 1, active: 1 });
ShopOwnershipSchema.index({ active: 1, expiresAt: 1 });

module.exports = mongoose.model('ShopOwnership', ShopOwnershipSchema);

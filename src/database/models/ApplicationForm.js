const mongoose = require('mongoose');

// One question in an application form (shown in Discord's pop-up form — at most 5 per form).
const QuestionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true }, // ≤45 chars (Discord's limit for a form label)
    placeholder: { type: String, default: '' },
    style: { type: String, enum: ['short', 'paragraph'], default: 'paragraph' },
    required: { type: Boolean, default: true },
    minLength: { type: Number, default: 0 },
    maxLength: { type: Number, default: 1000 }
  },
  { _id: false }
);

// An application form (e.g. "Guide Editor"): a panel with an Apply button posted in any channel, the
// questions applicants answer, who may apply, and where/how applications are reviewed.
const ApplicationFormSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    formId: { type: String, required: true }, // short id used in button ids (unique per guild)
    name: { type: String, required: true }, // shown to reviewers and on the dashboard
    open: { type: Boolean, default: true }, // accepting applications

    panel: {
      channelId: { type: String, default: null },
      messageId: { type: String, default: null },
      content: { type: String, default: '' }, // message text above the embed (role pings work here)
      title: { type: String, default: '📝 Apply' },
      description: { type: String, default: 'Press the button below to apply.' },
      color: { type: String, default: '#5865F2' },
      imageUrl: { type: String, default: '' },
      thumbnailUrl: { type: String, default: '' },
      footer: { type: String, default: '' }
    },
    button: {
      label: { type: String, default: 'Apply' },
      emoji: { type: String, default: '📝' },
      style: { type: String, default: 'Primary' }
    },
    questions: { type: [QuestionSchema], default: [] },

    requirements: {
      minLevel: { type: Number, default: 0 },
      minAccountAgeDays: { type: Number, default: 0 },
      minDaysInServer: { type: Number, default: 0 },
      requiredRoleId: { type: String, default: null }
    },
    limits: {
      reapplyCooldownHours: { type: Number, default: 72 }, // after a denial
      blockIfHasRole: { type: Boolean, default: true } // can't apply for a role you already have
    },

    review: {
      channelId: { type: String, default: null }, // where applications are posted
      pingRoleIds: { type: [String], default: [] }, // pinged on each new application (optional)
      reviewerRoleIds: { type: [String], default: [] }, // may approve/deny (Manage Server always can)
      approveRoleId: { type: String, default: null }, // given on approval (optional)
      dmApplicant: { type: Boolean, default: true },
      approveMessage: { type: String, default: '🎉 Your application for **{form}** in **{server}** was approved!' },
      denyMessage: { type: String, default: 'Your application for **{form}** in **{server}** was not accepted this time.' }
    }
  },
  { timestamps: true }
);

ApplicationFormSchema.index({ guildId: 1, formId: 1 }, { unique: true });

module.exports = mongoose.model('ApplicationForm', ApplicationFormSchema);

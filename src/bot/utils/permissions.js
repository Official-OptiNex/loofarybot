const { PermissionFlagsBits } = require('discord.js');
const { LOOFARY_USER_ID } = require('../../config');

function isAuthorized(interaction) {
  const isOwner = interaction.user.id === LOOFARY_USER_ID;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return isOwner || isAdmin;
}

module.exports = { isAuthorized };

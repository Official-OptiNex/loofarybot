// Role-based entry requirements: any-of (USA or Russia), all-of (USA and Android), blocked,
// the legacy single-role fold, and cleanRequirements validation — checked against real discord.js members.
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const { Client, GatewayIntentBits } = require(root + 'node_modules/discord.js');
const G = require(root + 'src/bot/cogs/modules/giveaways');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const guild = client.guilds._add({
  id: '100000000000000001',
  name: 'Lounge',
  owner_id: '1',
  channels: [],
  members: [],
  roles: [
    { id: '100000000000000001', name: '@everyone', permissions: '0', position: 0 },
    { id: '200000000000000002', name: 'USA', permissions: '0', position: 4 },
    { id: '300000000000000003', name: 'Russia', permissions: '0', position: 3 },
    { id: '400000000000000004', name: 'Android', permissions: '0', position: 2 },
    { id: '500000000000000005', name: 'Member', permissions: '0', position: 1 }
  ]
});
const USA = '200000000000000002',
  RUSSIA = '300000000000000003',
  ANDROID = '400000000000000004',
  MEMBER = '500000000000000005';
const now = new Date().toISOString();
const mk = (id, roles) => guild.members._add({ user: { id, username: 'u' + id }, roles, joined_at: now });

const usa = mk('11', [MEMBER, USA]);
const russia = mk('12', [MEMBER, RUSSIA]);
const usaAndroid = mk('13', [MEMBER, USA, ANDROID]);
const plain = mk('14', [MEMBER]);

const met = (reason, msg) => assert.equal(reason, null, msg);
const notMet = (reason, msg) => assert.ok(reason && reason.includes("don't meet"), msg);

(async () => {
  // any-of: "USA or Russia can enter" — USD Amazon doesn't work with the Russians, so this is the allow-list form.
  const gAny = { requirements: G.cleanRequirements({ roleIdsAny: [USA, RUSSIA] }, guild) };
  met(await G.checkRequirements(usa, gAny), 'USA satisfies any-of (USA, Russia)');
  met(await G.checkRequirements(russia, gAny), 'Russia satisfies any-of (USA, Russia)');
  notMet(await G.checkRequirements(plain, gAny), 'no listed role fails any-of');
  console.log('✓ any-of: a member needs at least one of the listed roles');

  // all-of: "must be USA role AND Android role".
  const gAll = { requirements: G.cleanRequirements({ roleIdsAll: [USA, ANDROID] }, guild) };
  met(await G.checkRequirements(usaAndroid, gAll), 'USA+Android satisfies all-of');
  notMet(await G.checkRequirements(usa, gAll), 'USA alone fails all-of (missing Android)');
  console.log('✓ all-of: a member needs every listed role');

  // blocked: exclude a role (the inverse of the allow-list, natural for "no Russians").
  const gBlocked = { requirements: G.cleanRequirements({ blockedRoleIds: [RUSSIA] }, guild) };
  met(await G.checkRequirements(usa, gBlocked), 'no Russia role passes blocked');
  notMet(await G.checkRequirements(russia, gBlocked), 'Russia role fails blocked');
  console.log('✓ blocked: a member with a blocked role is rejected');

  // Combined any + all + blocked all checked together.
  const gCombo = { requirements: G.cleanRequirements({ roleIdsAny: [USA, RUSSIA], roleIdsAll: [ANDROID], blockedRoleIds: [RUSSIA] }, guild) };
  met(await G.checkRequirements(usaAndroid, gCombo), 'USA+Android: has any, has all, not blocked');
  notMet(await G.checkRequirements(russia, gCombo), 'Russia: blocked and missing Android');
  console.log('✓ any + all + blocked are evaluated together');

  // Legacy single roleId still works: it folds into any-of on read.
  const lists = G.reqRoleLists({ roleId: USA });
  assert.deepEqual(lists.any, [USA], 'legacy roleId folds into any-of');
  const gLegacy = { requirements: { roleId: USA } };
  met(await G.checkRequirements(usa, gLegacy), 'legacy roleId: having it passes');
  notMet(await G.checkRequirements(plain, gLegacy), 'legacy roleId: missing it fails');
  console.log('✓ legacy single roleId still enforced (folded into any-of)');

  // cleanRequirements validation: unknown roles dropped, dups removed, roleId cleared, numbers clamped.
  const cleaned = G.cleanRequirements(
    { roleId: USA, roleIdsAny: [USA, '999999999999999999'], roleIdsAll: [ANDROID, ANDROID], minDaysInServer: '9999', minLevel: '-5' },
    guild
  );
  assert.equal(cleaned.roleId, null, 'roleId is cleared once folded into the lists');
  assert.deepEqual(cleaned.roleIdsAny, [USA], 'unknown role dropped, legacy roleId merged, no dups');
  assert.deepEqual(cleaned.roleIdsAll, [ANDROID], 'duplicates collapsed');
  assert.equal(cleaned.minDaysInServer, 3650, 'minDaysInServer clamped to 3650');
  assert.equal(cleaned.minLevel, null, 'negative minLevel becomes null');
  console.log('✓ cleanRequirements validates roles against the guild, dedups, clears legacy roleId, clamps numbers');

  // No requirements at all → everyone is eligible.
  assert.equal(await G.checkRequirements(plain, { requirements: G.cleanRequirements({}, guild) }), null, 'empty requirements let anyone in');
  assert.equal(G.hasRequirements(G.cleanRequirements({}, guild)), false, 'empty requirements report none');
  console.log('✓ empty requirements let anyone enter');

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

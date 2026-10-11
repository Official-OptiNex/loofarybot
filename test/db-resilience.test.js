// DB resilience: isDbUnavailable() recognises a momentary "database unreachable" error (a dropped /
// reconnecting Atlas connection or a buffering timeout) so interactions show a friendly "try again"
// message instead of a silent 3s timeout — while a genuine bug still reads as an internal error.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { isDbUnavailable } = require(root+'src/database/db');

(async () => {
  // Transient DB-down errors → true.
  const mkName=(name)=>{ const e=new Error('boom'); e.name=name; return e; };
  assert.equal(isDbUnavailable(mkName('MongooseServerSelectionError')),true,'server selection error');
  assert.equal(isDbUnavailable(mkName('MongoNetworkError')),true,'network error');
  assert.equal(isDbUnavailable(mkName('MongoNotConnectedError')),true,'not connected');
  assert.equal(isDbUnavailable(new Error('Operation `guildconfigs.findOne()` buffering timed out after 2500ms')),true,'buffering timeout (the exact symptom)');
  assert.equal(isDbUnavailable(new Error('connect ECONNREFUSED 10.0.0.1:27017')),true,'connection refused');
  assert.equal(isDbUnavailable(new Error('Server selection timed out after 15000 ms')),true,'server selection timeout');
  assert.equal(isDbUnavailable(new Error('Topology was destroyed')),true,'topology destroyed');

  // Real bugs and non-DB errors → false, so they still read as a genuine internal error.
  assert.equal(isDbUnavailable(new TypeError("Cannot read properties of undefined (reading 'id')")),false,'a real code bug');
  assert.equal(isDbUnavailable(new Error('Missing Permissions')),false,'a Discord permission error');
  assert.equal(isDbUnavailable(null),false,'no error object');
  assert.equal(isDbUnavailable(undefined),false,'undefined');

  console.log('✓ isDbUnavailable: transient DB-down errors are retry-able; real bugs are not');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});

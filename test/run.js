// Runs every test/*.test.js in its own process (they stub modules globally) and prints a summary.
// Usage: npm test            — all tests
//        npm test -- tickets — only files whose name contains "tickets"
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 180 * 1000;
const PARALLEL = 4;
const filter = process.argv[2] || '';
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js') && f.includes(filter))
  .sort();

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'no-db.js'), path.join(__dirname, file)], { env: { ...process.env, NODE_ENV: 'test' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, code, signal, out, ms: Date.now() - started });
    });
  });
}

(async () => {
  if (!files.length) {
    console.log(`No test files match "${filter}".`);
    process.exit(1);
  }
  const results = [];
  const queue = [...files];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) {
        const r = await runOne(queue.shift());
        results.push(r);
        const checks = (r.out.match(/✓/g) || []).length;
        console.log(`${r.ok ? '✅' : '❌'} ${r.file.replace('.test.js', '').padEnd(24)} ${String(checks).padStart(2)} checks  ${(r.ms / 1000).toFixed(1)}s`);
      }
    })
  );
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`\n──── ${r.file} ${r.signal ? `(killed: ${r.signal}, over ${TIMEOUT_MS / 1000}s)` : `(exit ${r.code})`} ────`);
    console.log(r.out.split('\n').filter((l) => !/Missing optional env vars/.test(l)).slice(-30).join('\n'));
  }
  console.log(`\n${results.length - failed.length}/${results.length} test files passed.`);
  process.exit(failed.length ? 1 : 0);
})();

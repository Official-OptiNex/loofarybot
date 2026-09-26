// Word-level diff (LCS) used to highlight what changed in edited messages.
const MAX_TOKENS = 600;

function tokenize(str) {
  return String(str || '').split(/(\s+)/).filter((t) => t.length > 0);
}

/**
 * Returns [{ type: 'same' | 'add' | 'del', text }]. Very long messages fall back to a single
 * delete + add, which keeps the O(n·m) table bounded.
 */
function diffWords(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      ...(before ? [{ type: 'del', text: before }] : []),
      ...(after ? [{ type: 'add', text: after }] : [])
    ];
  }

  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i++]);
    } else {
      push('add', b[j++]);
    }
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('add', b[j++]);
  return ops;
}

module.exports = { diffWords };

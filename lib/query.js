// 布尔标签查询：逗号/& 交集，+ / | 并集，- 差集，! / ~ 补集，? 全文检索，"a b" 隐式 AND，\ 转义
// 行为对标 TagSieve 的 query.js，但代码自写（原始实现受 MPL 1.1 约束，且依赖 Places SQL）

import { tagKey, cpCompare } from './title.js';

const OPS = {
  ',': 'AND',
  '&': 'AND',
  '+': 'OR',
  '|': 'OR',
  '-': 'DIFF',
  '!': 'NOT',
  '~': 'NOT',
  '?': 'SEARCH',
  '(': 'LP',
  ')': 'RP',
};

/** 标签名里出现这些字符时必须转义，否则会被当成运算符 */
const NEEDS_ESCAPE = new Set(['&', ',', '+', '-', '|', '!', '~', '?', '(', ')', '\\', '@', '#']);

export function escapeTag(name) {
  let out = '';
  for (const ch of Array.from(String(name))) out += NEEDS_ESCAPE.has(ch) ? '\\' + ch : ch;
  return out;
}

// ---------------------------------------------------------------- 词法

export function tokenize(src) {
  const s = String(src == null ? '' : src);
  const tokens = [];
  const errors = [];
  let buf = '';
  let i = 0;

  let dirNext = false; // @ 前缀：下一个词是目录标签
  let tagNext = false; // # 前缀：下一个词只算普通标签（同名目录不参与）

  const flush = () => {
    if (buf) {
      tokens.push({ type: dirNext ? 'DIR' : tagNext ? 'TAGONLY' : 'WORD', value: buf, start: i - buf.length });
      buf = '';
    }
    dirNext = false;
    tagNext = false;
  };

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\') {
      if (i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
      } else {
        errors.push({ token: '\\', reason: 'dangling-escape' });
        i++;
      }
      continue;
    }

    if (ch === '@') {
      flush();
      dirNext = true;
      i++;
      continue;
    }

    if (ch === '#') {
      flush();
      tagNext = true;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }

    if (OPS[ch]) {
      flush();
      tokens.push({ type: OPS[ch], value: ch, start: i });
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();

  return { tokens, errors };
}

// ------------------------------------------------- 隐式 AND（相邻操作数）

const ENDS_OPERAND = new Set(['WORD', 'DIR', 'TAGONLY', 'RP']);
const STARTS_OPERAND = new Set(['WORD', 'DIR', 'TAGONLY', 'LP', 'NOT', 'SEARCH']);

function withImplicitAnd(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    out.push(tk);
    const next = tokens[i + 1];
    if (next && ENDS_OPERAND.has(tk.type) && STARTS_OPERAND.has(next.type)) {
      out.push({ type: 'AND', value: ' ', implicit: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 语法

 /**
  * 容错解析：错位的运算符直接丢弃并记一条 error，绝不抛异常。
  * 返回的 ast 为 null 时表示"整个表达式没有有效条件"。
  */
export function parse(src) {
  const { tokens, errors: lexErrors } = tokenize(src);
  const t = withImplicitAnd(tokens);
  const errors = [...lexErrors];
  let pos = 0;

  const peek = () => t[pos];

  function parseExpr() {
    let left = parseUnary();
    while (pos < t.length) {
      const tk = peek();
      let op = null;

      if (tk.type === 'AND' || tk.type === 'OR' || tk.type === 'DIFF') {
        op = next();
      } else if (left && STARTS_OPERAND.has(tk.type)) {
        // `a , , b` 这类：前一个运算符已经吃掉，这里按隐式 AND 接上，别把 b 丢掉
        op = { type: 'AND', value: ' ', implicit: true };
      } else {
        break;
      }

      const right = parseUnary();
      if (!right) {
        errors.push({ token: op.value, reason: 'missing-operand' });
        continue; // 丢掉这个运算符，保留左边
      }
      if (!left) {
        left = right;
        continue;
      }
      left = {
        type: op.type === 'AND' ? 'and' : op.type === 'OR' ? 'or' : 'diff',
        left,
        right,
      };
    }
    return left;
  }

  function next() {
    return t[pos++];
  }

  function parseUnary() {
    const tk = peek();
    if (!tk) return null;

    if (tk.type === 'NOT') {
      next();
      const n = parseUnary();
      return n ? { type: 'not', node: n } : null;
    }

    if (tk.type === 'SEARCH') {
      next();
      const t2 = peek();
      if (t2 && t2.type === 'WORD') {
        next();
        return { type: 'search', q: t2.value };
      }
      if (t2 && t2.type === 'RP') {
        // `(?foo)` 这种写法里，? 后面紧跟右括号 = 空检索
        return { type: 'search', q: '' };
      }
      return { type: 'search', q: '' };
    }

    if (tk.type === 'LP') {
      next();
      const e = parseExpr();
      if (peek() && peek().type === 'RP') next();
      else errors.push({ token: '(', reason: 'missing-paren' });
      return e;
    }

    if (tk.type === 'WORD') {
      next();
      return { type: 'tag', name: tk.value };
    }

    if (tk.type === 'DIR') {
      next();
      return { type: 'dir', name: tk.value };
    }

    if (tk.type === 'TAGONLY') {
      next();
      return { type: 'tagOnly', name: tk.value };
    }

    // 落单的右括号 / 多余运算符：跳过，保持容错
    next();
    if (tk.type !== 'RP') errors.push({ token: tk.value, reason: 'unexpected-operator' });
    return null;
  }

  const ast = parseExpr();
  if (pos < t.length) errors.push({ token: t[pos].value, reason: 'trailing-token' });

  return { ast, errors, tokens: t };
}

// ---------------------------------------------------------------- 求值

function intersect(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set();
  for (const k of small) if (big.has(k)) out.add(k);
  return out;
}

function union(a, b) {
  const out = new Set(a);
  for (const k of b) out.add(k);
  return out;
}

function difference(a, b) {
  const out = new Set(a);
  for (const k of b) out.delete(k);
  return out;
}

/**
 * @param ast parse() 的结果
 * @param index buildIndex() 的结果
 * @param {{resolveAlias?: (lower:string)=>string}} opts
 * @returns {Set<string>} urlKey 集合
 */
export function evaluate(ast, index, opts = {}) {
  const resolveAlias = opts.resolveAlias || ((k) => k);

  const search = (q) => {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return new Set(index.allKeys);
    const out = new Set();
    for (const key of index.allKeys) {
      const text = (index.keyToText.get(key) || '').toLowerCase();
      const url = (index.keyToUrl.get(key) || '').toLowerCase();
      if (text.includes(needle) || url.includes(needle)) out.add(key);
    }
    return out;
  };

  const evalNode = (n) => {
    if (!n) return new Set(index.allKeys);
    switch (n.type) {
      case 'dir': {
        // 目录标签是虚拟的；prefs.folderTags 关掉时整个维度不参与求值
        if (opts.dirEnabled === false) return new Set();
        const k = resolveAlias(tagKey(n.name));
        return new Set((index.dirTagToKeys && index.dirTagToKeys.get(k)) || []);
      }
      case 'tag': {
        const k = resolveAlias(tagKey(n.name));
        // 虚拟标签：没有任何标签的书签。TagSieve 的空查询看不到它们，这里补上。
        if (k === '未打标签' || k === 'untagged') {
          return new Set(index.untaggedKeys || []);
        }
        // 裸名 = 这个名字能命中的一切：标签 ∪ 目录（目录开关关掉时只算标签）
        const out = new Set(index.tagToKeys.get(k) || []);
        if (opts.dirEnabled !== false && index.dirTagToKeys) {
          for (const key of index.dirTagToKeys.get(k) || []) out.add(key);
        }
        return out;
      }
      case 'tagOnly': {
        // #前缀：只要普通标签，不掺同名目录
        const k = resolveAlias(tagKey(n.name));
        if (k === '未打标签' || k === 'untagged') {
          return new Set(index.untaggedKeys || []);
        }
        return new Set(index.tagToKeys.get(k) || []);
      }
      case 'search':
        return search(n.q);
      case 'not': {
        // 补集 = 全部书签 − 集合（不是"全部已标签"，否则未打标签的会被排除）
        return difference(new Set(index.allKeys), evalNode(n.node));
      }
      case 'and':
        return intersect(evalNode(n.left), evalNode(n.right));
      case 'or':
        return union(evalNode(n.left), evalNode(n.right));
      case 'diff':
        return difference(evalNode(n.left), evalNode(n.right));
      default:
        return new Set(index.allKeys);
    }
  };

  return evalNode(ast);
}

/** 表达式里出现过的标签（用于从相关标签里排除） */
export function collectQueryDirs(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.type === 'dir') out.add(tagKey(ast.name));
  if (ast.node) collectQueryDirs(ast.node, out);
  if (ast.left) collectQueryDirs(ast.left, out);
  if (ast.right) collectQueryDirs(ast.right, out);
  return out;
}

export function collectQueryTags(ast, out = new Set()) {
  if (!ast) return out;
  // dir 不收集：相关标签只统计真实标签，目录标签键撞名时也不该被误排除
  if (ast.type === 'tag' || ast.type === 'tagOnly') out.add(tagKey(ast.name));
  if (ast.node) collectQueryTags(ast.node, out);
  if (ast.left) collectQueryTags(ast.left, out);
  if (ast.right) collectQueryTags(ast.right, out);
  return out;
}

/**
 * 相关标签：结果集内每个标签的出现次数。
 * 因为只统计"当前结果里确实还有的标签"，所以点它永远不会得到空结果。
 */
export function relatedTags(index, keys, opts = {}) {
  const exclude = opts.exclude || new Set();
  const counts = new Map();
  for (const key of keys) {
    for (const tag of index.keyToTags.get(key) || []) {
      const k = tagKey(tag);
      if (exclude.has(k)) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([k, count]) => ({ key: k, tag: index.tagForm.get(k) || k, count }))
    // 字母序（中文按拼音），次数只做平手裁决——高频不再霸占左上角
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh') || b.count - a.count || cpCompare(a.tag, b.tag));
}

// --------------------------------------------------- UI 侧的表达式拼装

/**
 * 往查询表达式里加一个标签。
 * @param {'and'|'or'|'not'|'only'} mode
 */
export function insertTag(expr, tag, mode = 'and', prefix = '') {
  const cur = String(expr || '').trim();
  const t = prefix + escapeTag(tag);
  if (mode === 'only') return t;
  if (!cur) return mode === 'not' ? `!${t}` : t;
  if (mode === 'and') {
    if (hasTag(expr, tag, prefix)) return removeTag(expr, tag, prefix);
    // 同名裸名已存在时升级成精确前缀（裸名包含它，叠加是冗余）；
    // 其他前缀（@ 与 #）语义不同，允许共存
    let base = cur;
    if (prefix && hasTag(expr, tag, '')) base = removeTag(expr, tag, '');
    return base ? `${base}, ${t}` : t;
  }
  if (mode === 'or') return `${cur} + ${t}`;
  return `${cur} - ${t}`;
}

/** 判断表达式里是否已经含这个标签（用于点击切换） */
export function hasTag(expr, tag, prefix = '') {
  const t = prefix + escapeTag(tag);
  const re = new RegExp(
    `(?:^|[\\s,+])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s|[,+\\-)]|[)])`
  );
  return re.test(String(expr || ''));
}

/** 从表达式里摘掉某个标签（连同前后的运算符残留） */
export function removeTag(expr, tag, prefix = '') {
  const t = (prefix + escapeTag(tag)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s*([,]|\\+|\\-)?\\s*${t}(?=$|\\s|[),+\\-])`, 'g');
  return String(expr || '')
    .replace(re, '')
    .replace(/^[\s,+\-]+/, '')
    .replace(/[\s,+\-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

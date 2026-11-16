// 标题序列化：<干净标题> (空格 [#tag]...)? (空格 [**k:v;...])?
//
// 设计约束（见方案文档 §4.1）：
// - 配置组永远在末尾，标签组在它前面，解析只需从尾部剥两次
// - 标签各占一对方括号，所以标签名可含空格、中文、+、#，但不能含 [ ] ; = ,
// - 一律按码点序排序，禁用 localeCompare：不同设备的 ICU 不一样，排序不一致会导致
//   标题反复变化 → 同步无限抖动
// - 往返必须幂等：parse(build(x)) === x

export const FORBIDDEN_TAG_CHARS = ['[', ']', ';', '=', ','];
export const MAX_TAG_LEN = 120;

const CONF_TAIL = /\s*\[\*\*([^\[\]]*)\]\s*$/;
const TAG_TAIL = /\s*((?:\[#[^\[\]]*\]\s*)+)$/;
const TAG_ONE = /\[#([^\[\]]*)\]/g;

/** 按 Unicode 码点比较，跨设备稳定 */
export function cpCompare(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i].codePointAt(0);
    const cb = B[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length - B.length;
}

/** 标签比较用的键：只做小写折叠，不用 locale 相关方法 */
export function tagKey(name) {
  return String(name == null ? '' : name).toLowerCase();
}

/**
 * 校验并归一化标签名。
 * @returns {{ok: true, tag: string} | {ok: false, reason: string}}
 */
export function normalizeTag(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reason: 'empty' };
  for (const ch of FORBIDDEN_TAG_CHARS) {
    if (t.includes(ch)) return { ok: false, reason: 'forbidden:' + ch };
  }
  if (Array.from(t).length > MAX_TAG_LEN) return { ok: false, reason: 'too-long' };
  return { ok: true, tag: t };
}

/** 失败时返回 null，方便 UI 直接判空 */
export function normalizeTagOrNull(raw) {
  const r = normalizeTag(raw);
  return r.ok ? r.tag : null;
}

/** 一次输入多个标签：逗号、分号、竖线都当分隔符（这些本来就是配置里的分隔符） */
export function splitTags(input) {
  return String(input == null ? '' : input)
    .split(/[,;|、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 交互式输入用的切分：空格/逗号/分号/顿号/换行都算分隔；
 * 引号（" “ ” ‘ ’）包住的内容整体算一个标签，内部空格保留。
 * 例：`前端 学习 "Chrome 扩展"` → ['前端','学习','Chrome 扩展']
 */
export function splitTagInput(input) {
  const s = String(input == null ? '' : input);
  const out = [];
  let cur = '';
  let inQuote = false;
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  };
  for (const ch of s) {
    if (ch === '"' || ch === '“' || ch === '”' || ch === '‘' || ch === '’') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /[,;；、，\s|]/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

export function dedupeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const k = tagKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function sortTags(tags) {
  return [...tags].sort(cpCompare);
}

/** 去重 + 排序，写标题前统一走这个 */
export function normalizeTags(tags) {
  return sortTags(dedupeTags(tags));
}

/** 大小写不敏感查表，返回原始值 */
export function lookupCI(obj, name) {
  if (!obj) return undefined;
  const k = tagKey(name);
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === k) return obj[key];
  }
  return undefined;
}

/** 大小写不敏感写表：已有同名（不同大小写）时改原键，否则新增 */
export function setCI(obj, name, value) {
  const dict = obj || {};
  const k = tagKey(name);
  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() === k) {
      if (value == null) delete dict[key];
      else dict[key] = value;
      return dict;
    }
  }
  if (value != null) dict[name] = value;
  return dict;
}

function parsePairs(val, target, errors) {
  for (const item of String(val || '').split(',')) {
    const s = item.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) {
      errors.push({ token: s, reason: 'pair-no-eq' });
      continue;
    }
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!k || !v) {
      errors.push({ token: s, reason: 'pair-empty' });
      continue;
    }
    target[k] = v;
  }
}

/**
 * 解析配置组内容。
 * 支持的指令：v(版本) c(颜色) a(别名) p/r(条目级标记) 以及任意 key:value
 */
export function parseConfig(raw) {
  const conf = { v: 1, colors: {}, aliases: {}, flags: {}, extras: {}, errors: [] };
  const parts = String(raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const p of parts) {
    const i = p.indexOf(':');
    if (i < 0) {
      conf.errors.push({ token: p, reason: 'no-colon' });
      continue;
    }
    const rawKey = p.slice(0, i).trim();
    const key = rawKey.toLowerCase();
    const val = p.slice(i + 1).trim();

    if (key === 'v') {
      conf.v = Number(val) || 1;
    } else if (key === 'c') {
      parsePairs(val, conf.colors, conf.errors);
    } else if (key === 'a') {
      parsePairs(val, conf.aliases, conf.errors);
    } else if (key === 'p' || key === 'r') {
      if (val === '' || val === '1') conf.flags[key] = 1;
    } else {
      // 未知指令保留原大小写，避免 bmSort 被写成 bmsort 后再也认不出来
      conf.extras[rawKey] = val;
    }
  }
  return conf;
}

function directive(name, obj) {
  const items = Object.entries(obj || {}).filter(([k, v]) => k && String(v).length);
  if (!items.length) return '';
  items.sort((a, b) => cpCompare(a[0], b[0]));
  return `${name}:` + items.map(([k, v]) => `${k}=${v}`).join(',');
}

/** 序列化配置组内容（不含外层 [**...]） */
export function serializeConfig(conf) {
  if (!conf) return '';
  const parts = [];
  const v = conf.v || 1;
  parts.push(`v:${v}`);

  const c = directive('c', conf.colors);
  if (c) parts.push(c);
  const a = directive('a', conf.aliases);
  if (a) parts.push(a);

  for (const flag of ['p', 'r']) {
    if (conf.flags && conf.flags[flag]) parts.push(`${flag}:1`);
  }
  const extras = Object.entries(conf.extras || {}).filter(([k, v]) => k && String(v).length);
  extras.sort((x, y) => cpCompare(x[0], y[0]));
  for (const [k, val] of extras) parts.push(`${k}:${val}`);

  // 只有版本号时也返回空串，避免为了 v:1 而给每条标题加后缀
  if (parts.length === 1) return '';
  return parts.join(';');
}

/**
 * 拆标题。
 * @returns {{text: string, tags: string[], conf: object|null}}
 */
export function parseTitle(raw) {
  let rest = String(raw == null ? '' : raw);
  let conf = null;

  const cm = rest.match(CONF_TAIL);
  if (cm) {
    conf = parseConfig(cm[1]);
    rest = rest.slice(0, cm.index);
  }

  const tm = rest.match(TAG_TAIL);
  const tags = [];
  let text = rest;
  if (tm) {
    text = rest.slice(0, tm.index);
    for (const hit of tm[1].matchAll(TAG_ONE)) {
      const t = normalizeTagOrNull(hit[1]);
      // 归一化失败的标签（含非法字符）静默丢弃，避免把脏数据写回去
      if (t && !tags.some((x) => tagKey(x) === tagKey(t))) tags.push(t);
    }
  }

  return { text: String(text).trim(), tags: sortTags(tags), conf };
}

/** 拼接标题 */
export function buildTitle(text, tags, conf) {
  const clean = String(text == null ? '' : text).trim();
  const tg = normalizeTags(tags)
    .map((t) => `[#${t}]`)
    .join('');
  const confBody = conf ? serializeConfig(conf) : '';
  const cg = confBody ? `[**${confBody}]` : '';
  const tail = [tg, cg].filter(Boolean).join(' ');
  if (!tail) return clean;
  return clean ? `${clean} ${tail}` : tail;
}

/** 只取干净标题（搜索、展示用） */
export function cleanText(rawTitle) {
  return parseTitle(rawTitle).text;
}

/** 标题里是否有可解析的标签或配置（用于识别"用户自己写的 [#x]"这类误判） */
export function looksTagged(rawTitle) {
  const p = parseTitle(rawTitle);
  return p.tags.length > 0 || !!p.conf;
}

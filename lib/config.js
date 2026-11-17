// 配置文件书签的定义（纯逻辑，可单测）
// 其他书签/TagSpace/ 下，一类配置一个专用书签：
//   TagSpace 配置·颜色 → space.html#cfg=colors
//   TagSpace 配置·偏好 → space.html#cfg=prefs
//   TagSpace 配置·别名 → space.html#cfg=aliases

export const OTHER_BOOKMARKS_ID = '2';
export const CONFIG_DIR_NAME = 'TagSpace';
export const CONFIG_FILE_PREFIX = 'TagSpace 配置·';

export const CATEGORIES = {
  colors: {
    key: 'colors',
    label: '颜色',
    file: 'TagSpace 配置·颜色',
    hash: 'cfg=colors',
    hint: 'c:标签=调色板序号(0-11) 或 #RRGGBB',
  },
  prefs: {
    key: 'prefs',
    label: '偏好',
    file: 'TagSpace 配置·偏好',
    hash: 'cfg=prefs',
    hint: 'v:1;bmSort:title;bmDir:asc;view:cloud;rank:relatedSize;click:pop;relatedOnly:1',
  },
  aliases: {
    key: 'aliases',
    label: '别名',
    file: 'TagSpace 配置·别名',
    hash: 'cfg=aliases',
    hint: 'a:别名=规范标签',
  },
};

const LABEL_TO_KEY = {
  颜色: 'colors',
  偏好: 'prefs',
  别名: 'aliases',
};

/** 跨设备应一致的偏好；设备级的东西不放这里 */
export const DEFAULT_PREFS = {
  folderTags: '1', // 目录标签（文件夹层级投影）：'1' 开 '0' 关
  bmSort: 'title',
  bmDir: 'asc',
  rank: 'relatedSize',
  view: 'cloud',
  click: 'pop',
  relatedOnly: '1',
  trashPath: '', // 回收站目录的书签路径（不是 id：id 不跨设备，路径随标题同步）
};

/** 跨设备应一致，但可能超出标题长度的内容（如收件箱文件夹 id）不进这里 */

/**
 * 识别一个书签节点属于哪类配置文件。
 * 主判据：URL 的 hash；兜底：标题前缀（用户改了标题也不影响识别，改的是 URL 才影响）
 */
export function categoryOf(node) {
  if (!node || !node.url) return null;
  const m = /#cfg=([a-z]+)/.exec(node.url);
  if (m && CATEGORIES[m[1]]) return m[1];
  const tm = new RegExp(`^${CONFIG_FILE_PREFIX.replace('·', '·')}(\\S+)`).exec(node.title || '');
  if (tm && LABEL_TO_KEY[tm[1]]) return LABEL_TO_KEY[tm[1]];
  return null;
}

/** 按类别拼出这条配置文件的标题 */
export function configFileTitle(categoryKey, body) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return body || '';
  return body ? `${cat.file} [**${body}]` : cat.file;
}

/** 取出只跟本类别相关的配置，避免把 c: 写进别名文件 */
export function sanitizeConfFor(categoryKey, conf) {
  const c = conf || {};
  const base = { v: c.v || 1, colors: {}, aliases: {}, flags: {}, extras: {} };
  if (categoryKey === 'colors') {
    base.colors = c.colors || {};
  } else if (categoryKey === 'aliases') {
    base.aliases = c.aliases || {};
  } else {
    base.extras = c.extras || {};
  }
  return base;
}

/**
 * 同一类别出现多条文件时（两台设备在首次同步完成前各建了一套），
 * 按固定顺序排：dateAdded 早者优先，同批次比 id 字典序。
 * 这个顺序必须可复现 —— 否则两台设备各写各的文件，配置会越分越远。
 */
export function canonicalOrder(nodes) {
  return (nodes || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const da = a.dateAdded || 0;
      const db = b.dateAdded || 0;
      if (da !== db) return da - db;
      const ia = String(a.id);
      const ib = String(b.id);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
}

/** 规范文件 = 排序后的第一条 */
export function pickCanonical(nodes) {
  const list = canonicalOrder(nodes);
  return list.length ? list[0] : null;
}

const MERGE_FIELD = { colors: 'colors', aliases: 'aliases', prefs: 'extras' };

/**
 * 合并同一类别的多份配置：并集填充，键冲突时以规范文件（list[0]）为准。
 * 只合并本类别字段，不把 c: 混进别名文件。
 */
export function mergeConfs(categoryKey, confs) {
  const list = (confs || []).filter(Boolean);
  const field = MERGE_FIELD[categoryKey] || 'extras';
  const merged = {};
  const conflicts = [];
  let filled = 0;

  const first = list[0] || {};
  for (const [k, v] of Object.entries(first[field] || {})) {
    if (k && String(v).length) merged[k] = v;
  }
  for (let i = 1; i < list.length; i++) {
    for (const [k, v] of Object.entries(list[i][field] || {})) {
      if (!k || !String(v).length) continue;
      if (merged[k] === undefined) {
        merged[k] = v;
        filled++;
      } else if (String(merged[k]) !== String(v)) {
        conflicts.push({ key: k, kept: merged[k], dropped: v });
      }
    }
  }

  // 版本号取最大；p / r 这类布尔标记取或
  let v = 1;
  const flags = {};
  for (const c of list) {
    if (Number(c.v) > v) v = Number(c.v);
    for (const [k, val] of Object.entries(c.flags || {})) if (val) flags[k] = 1;
  }

  const out = { v, colors: {}, aliases: {}, flags, extras: {} };
  out[field] = merged;
  return { conf: out, conflicts, filled, sources: list.length };
}

// ---------------------------------------------------------------- 名单编码
// 目录名单存在 `p:1` 配置组里，`,` 分项、`;` 分组。文件夹名自带这两个字符会把格式拆坏，
// 所以编码后再写：% 先编码，再替换 , ; ——解码顺序相反，老数据（本来不含这两个字符）不受影响。
// 第 31 号控制字符是内部路径分隔符（PATH_SEP），书签标题里不能存控制字符，一并编成 %1F。
const LIST_SEP_CHAR = String.fromCharCode(31);
export function encodeListName(name) {
  return String(name)
    .replace(/%/g, '%25')
    .replace(/,/g, '%2C')
    .replace(/;/g, '%3B')
    .split(LIST_SEP_CHAR)
    .join('%1F');
}

export function decodeListName(name) {
  return String(name)
    .replace(/%1F/gi, LIST_SEP_CHAR)
    .replace(/%3B/gi, ';')
    .replace(/%2C/gi, ',')
    .replace(/%25/g, '%');
}

export function joinList(list) {
  return (list || []).map(encodeListName).join(',');
}

export function splitList(str) {
  return String(str || '')
    .split(',')
    .map((x) => decodeListName(x.trim()))
    .filter(Boolean);
}

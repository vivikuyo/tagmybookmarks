// 标签颜色：未显式设色的标签按 hash(标签名) % 12 取色
// 好处是默认就好看，且零存储成本——只有手动改过色的标签才进颜色配置文件

import { lookupCI, tagKey } from './title.js';

export const PALETTE = [
  { name: '灰', hex: '#8a8f98' },
  { name: '红', hex: '#e5484d' },
  { name: '橙', hex: '#ef8b22' },
  { name: '黄', hex: '#c9a227' },
  { name: '绿', hex: '#2f9e63' },
  { name: '青', hex: '#149a90' },
  { name: '蓝', hex: '#3b63d8' },
  { name: '靛', hex: '#6b56c8' },
  { name: '紫', hex: '#9c3f96' },
  { name: '粉', hex: '#cf3f93' },
  { name: '棕', hex: '#a4683c' },
  { name: '墨', hex: '#4a5568' },
];

export function hashIndex(name) {
  let h = 0;
  for (const ch of Array.from(tagKey(name))) h = (h + ch.codePointAt(0)) % 12;
  return h;
}

/** 配置文件里的值可以是调色板序号 "3"，也可以是 "#RRGGBB" */
export function resolveColorValue(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const c = v.slice(1);
    return '#' + c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n < PALETTE.length) return PALETTE[n].hex;
  return null;
}

/** 取标签最终显示色：配置优先，否则哈希默认 */
export function colorFor(tag, colors) {
  const explicit = resolveColorValue(lookupCI(colors, tag));
  if (explicit) return explicit;
  return PALETTE[hashIndex(tag)].hex;
}

export function isExplicitColor(tag, colors) {
  return resolveColorValue(lookupCI(colors, tag)) != null;
}

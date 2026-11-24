// 「时光匣」：一个能自己打开的网页文件，里面有密文和拆信程序。
// 没有本工具、没有网络，只要有浏览器和口令就能读。
import { letterToJSON, letterFromJSON } from './crypto.js';

const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

export function buildTimebox(box, list, sources, now) {
  const data = { format: 'shiguangjiashu', v: 1, exportedAt: now, box, letters: list.map(letterToJSON) };
  // 合成一个普通脚本：去掉 import / export
  const plain = (s) => s.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const js = plain(sources.crypto) + '\n' + plain(sources.reader);
  return sources.template
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'))
    .replace('__DATA__', () => safe(data));
}

export function parseTimebox(text) {
  const m = text.match(/<script id="timebox" type="application\/json">([\s\S]*?)<\/script>/);
  let d;
  try { d = JSON.parse(m ? m[1] : text); } catch { throw new Error('这不是时光匣备份文件'); }
  if (d?.format !== 'shiguangjiashu' || !d.box?.pub || !d.box.byPass || !Array.isArray(d.letters)) throw new Error('这不是时光匣备份文件');
  return { box: d.box, letters: d.letters.map(letterFromJSON) };
}

export async function loadSources() {
  const [crypto, reader, template] = await Promise.all(['js/crypto.js', 'js/reader.js', 'reader.template.html'].map(async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error('读取拆信程序失败，请联网后再试');
    return r.text();
  }));
  return { crypto, reader, template };
}

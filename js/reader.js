// 时光匣内嵌的拆信程序（与 crypto.js 合成一个脚本）。
import { unlockBox, openLetter, letterFromJSON, todayStr } from './crypto.js';

const data = JSON.parse(document.getElementById('timebox').textContent);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
let priv = null;

$('name').textContent = data.box.name;
$('info').textContent = `共 ${data.letters.length} 封信 · 备份于 ${data.exportedAt}`;

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '正在开锁……';
  try {
    priv = (await unlockBox(data.box, $('pass').value)).key;
    $('form').remove();
    $('msg').textContent = '';
    list();
  } catch (err) { $('msg').textContent = err.message; }
});

function list() {
  for (const j of data.letters) {
    const can = j.unlockAt <= todayStr();
    const b = el('button', 'item', `${j.from} · ${j.createdAt.slice(0, 10)}${j.cover ? ' · ' + j.cover : ''}`);
    b.append(el('small', '', can ? '拆开' : `${j.unlockAt} 可拆`));
    b.disabled = !can;
    b.onclick = async () => {
      try { show(b, await openLetter(priv, letterFromJSON(j))); } catch (err) { $('msg').textContent = err.message; }
    };
    $('list').append(b);
  }
}

function show(btn, c) {
  const box = el('article', 'paper');
  for (const q of c.qa) box.append(el('p', 'q', q.q), el('p', 'text', q.a));
  if (c.text) box.append(el('p', 'text', c.text));
  for (const f of c.files) {
    const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
    const n = el(f.kind === 'audio' ? 'audio' : 'img');
    if (f.kind === 'audio') n.controls = true; else n.alt = f.kind === 'drawing' ? '画' : '照片';
    n.src = url;
    box.append(n);
  }
  btn.replaceWith(box);
}

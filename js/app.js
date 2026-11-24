import * as C from './crypto.js';
import * as D from './dates.js';
import * as S from './store.js';
import { YEARLY, promptsFor } from './prompts.js';
import { buildTimebox, parseTimebox, loadSources } from './backup.js';
import { makeClient } from './github.js';
import { startRecording, loadPhoto, drawPad, MAX_SECONDS } from './media.js';

const main = document.getElementById('main');
let box = null; // 信箱（不含明文私钥）
let priv = null; // 拆信私钥，只在内存里
let privTimer = 0;
let leave = null; // 离开当前页面时要做的事
let urls = [];

// ---------- 小工具 ----------
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((x) => x != null && x !== false));
  return n;
}
let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 4000);
}
// 按钮执行异步操作：期间禁用，出错时提示
function act(label, fn, cls = '') {
  const b = h('button', { class: cls, type: 'button', onclick: async () => {
    b.disabled = true;
    try { await fn(b); } catch (e) { toast(e.message || '出错了'); } finally { b.disabled = false; }
  } }, label);
  return b;
}
const go = (p) => { location.hash = p; };
function blobURL(f) { const u = URL.createObjectURL(new Blob([f.bytes], { type: f.mime })); urls.push(u); return u; }
function page(title, ...kids) {
  main.replaceChildren(h('header', { class: 'bar' }, h('a', { href: '#/', class: 'back', onclick: () => { if (['', '#/'].includes(location.hash)) route(); } }, '‹ 返回'), h('h1', {}, title)), ...kids.flat().filter(Boolean));
  scrollTo(0, 0);
}
function field(label, input) { return h('label', { class: 'field' }, h('span', {}, label), input); }
function remember(key) {
  priv = key;
  clearTimeout(privTimer);
  privTimer = setTimeout(() => { priv = null; }, 10 * 60e3); // 十分钟后自动忘记
}
async function metaState() {
  const list = await S.letters();
  return { list, backed: (await S.get('backup')) || { ids: [], at: null }, gh: await S.get('github'), checkAt: await S.get('checkAt') };
}

// ---------- 第一次使用 ----------
function welcome() {
  main.replaceChildren(h('section', { class: 'hero' },
    h('div', { class: 'envelope', 'aria-hidden': 'true' }, h('i')),
    h('h1', {}, '时光家书'),
    h('p', {}, '把现在的声音、字和画封进信里，等孩子长大那天再拆。'),
    act('建一个信箱', setup, 'primary'),
    act('我有备份，恢复信箱', restorePage),
  ));
}

function setup() {
  const name = h('input', { maxLength: 20, autocomplete: 'off', placeholder: '小名也可以' });
  const birth = h('input', { type: 'date', max: D.todayStr() });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  page('建一个信箱', h('div', { class: 'card' },
    field('孩子的称呼', name), field('孩子的生日', birth),
    h('p', { class: 'note' }, '口令是拆信的钥匙，大人保管。写信、封信都不需要它，孩子可以自己投。'),
    field('口令（至少 8 个字，建议一句只有家人懂的话）', p1), field('再输一次口令', p2),
    act('下一步', async (b) => {
      if (!name.value.trim()) throw new Error('写上孩子的称呼');
      if (!birth.value || birth.value > D.todayStr() || birth.value < '1900-01-01') throw new Error('选择孩子的生日');
      if (C.normPass(p1.value).length < 8) throw new Error('口令至少 8 个字');
      if (C.normPass(p1.value) !== C.normPass(p2.value)) throw new Error('两次口令不一样');
      b.textContent = '正在打造信箱……';
      const code = C.newRecoveryCode();
      try {
        const nb = await C.createBox({ name: name.value.trim(), birth: birth.value, createdAt: new Date().toISOString(), passAt: new Date().toISOString() }, p1.value, code);
        showCode(nb, code);
      } finally { b.textContent = '下一步'; }
    }, 'primary'),
  ));
}

function showCode(nb, code) {
  const check = h('input', { autocomplete: 'off', maxLength: 8, placeholder: '最后 5 位' });
  page('抄下恢复码', h('div', { class: 'card' },
    h('p', {}, '忘了口令时，只有它能打开信箱。现在就抄在纸上或打印出来，和户口本放在一起。'),
    h('div', { class: 'paper code' }, h('b', {}, `${nb.name}的时光家书 · 恢复码`), h('p', {}, code), h('small', {}, '打开时光匣备份文件或「时光家书」网页，在输入口令的地方输入这串恢复码即可。')),
    act('打印', () => window.print()),
    h('p', { class: 'note' }, '口令和恢复码都丢了，信就永远打不开了，谁也帮不了忙。最好让另一位家人也知道它放在哪里。'),
    field('抄好了？输入恢复码的最后 5 位', check),
    act('启用信箱', async () => {
      if (C.normCode(check.value) !== code.slice(-5)) throw new Error('跟恢复码的最后 5 位不一样');
      await S.set('box', nb);
      await S.set('checkAt', D.todayStr());
      box = nb;
      navigator.storage?.persist?.().catch(() => {});
      go('#/'); route();
    }, 'primary'),
  ));
}

// ---------- 恢复 ----------
async function adopt({ box: b, letters }) {
  if (box && box.id !== b.id) throw new Error('这是另一个信箱的备份，不能混在一起');
  if (letters.some((l) => l.boxId !== b.id)) throw new Error('备份里混进了别的信箱的信');
  const n = await S.mergeLetters(letters);
  if (!box || (b.passAt || '') > (box.passAt || '')) { await S.set('box', b); box = b; }
  if (!(await S.get('checkAt'))) await S.set('checkAt', D.todayStr());
  toast(`恢复了 ${n} 封信`);
}

function restorePage() {
  page('恢复信箱', h('div', { class: 'card' }, h('h2', {}, '从时光匣文件'), h('p', {}, '可以一次选多个文件，重复的信会自动跳过。'), pickTimebox()),
    h('div', { class: 'card' }, h('h2', {}, '从 GitHub 私有仓库'), githubForm(async (cfg) => {
      await adopt(await makeClient(cfg).pull());
      await S.set('github', cfg);
      go('#/'); route();
    }, '恢复')));
}

function pickTimebox() {
  return field('选择时光匣文件', h('input', { type: 'file', accept: '.html,.json,text/html', multiple: true, onchange: async (e) => {
    try {
      for (const f of e.target.files) await adopt(parseTimebox(await f.text()));
      go('#/'); route();
    } catch (err) { toast(err.message); }
  } }));
}

function githubForm(fn, label, old = {}) {
  const repo = h('input', { value: old.repo || '', placeholder: '用户名/仓库名', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const token = h('input', { type: 'password', value: old.token || '', autocomplete: 'off' });
  return h('div', {}, field('私有仓库', repo), field('访问令牌（fine-grained token）', token),
    act(label, () => fn({ repo: repo.value.trim(), token: token.value.trim() }), 'primary'));
}

// ---------- 首页：每封信是一颗星 ----------
function starPos(id, i) {
  // 位置由信的编号决定，永远不变
  let x = 2166136261;
  for (const ch of id + i) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0;
  const y = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
  return [6 + (x % 880) / 10, 8 + (y % 800) / 10];
}

async function home() {
  const { list, backed, checkAt, gh } = await metaState();
  const today = D.todayStr();
  const ready = list.filter((l) => l.unlockAt <= today);
  const unsaved = list.filter((l) => !backed.ids.includes(l.id)).length;
  const month = list.some((l) => l.createdAt.slice(0, 7) === today.slice(0, 7));
  const next = list.filter((l) => l.unlockAt > today).sort((a, b) => (a.unlockAt < b.unlockAt ? -1 : 1))[0];
  const eighteen = D.addYears(box.birth, 18);
  const sky = h('div', { class: 'sky', role: 'img', 'aria-label': `${list.length} 封信，每封信是一颗星` });
  list.forEach((l, i) => {
    const [x, y] = starPos(l.id, i);
    sky.append(h('i', { class: 'star' + (l.unlockAt <= today ? ' ready' : '') + (l.from === box.name ? ' kid' : ''), style: `left:${x}%;top:${y}%` }));
  });
  if (!list.length) sky.append(h('p', {}, '写下第一封信，点亮第一颗星'));
  const tips = [];
  if (ready.length) tips.push(h('a', { class: 'tip gold', href: '#/letters' }, `有 ${ready.length} 封信可以拆了`));
  if (unsaved) tips.push(h('a', { class: 'tip', href: '#/keep' }, gh ? `${unsaved} 封信等待备份` : `有 ${unsaved} 封信还没备份，换设备或清缓存会丢`));
  if (checkAt && D.daysBetween(checkAt, today) > 365) tips.push(h('a', { class: 'tip', href: '#/keep' }, '一年没检查了，来做一次体检，顺便确认还记得口令'));
  main.replaceChildren(
    h('header', { class: 'top' }, h('div', {}, h('h1', {}, `写给${box.name}`), h('p', {}, `${D.ageOn(box.birth, today)} 岁 · ${eighteen > today ? `离 18 岁${D.untilText(eighteen, today)}` : '已经长大了'}`))),
    sky,
    h('p', { class: 'count' }, list.length ? `${list.length} 封信。${next ? `下一封${D.untilText(next.unlockAt, today)}拆开` : ''}` : ''),
    ...tips,
    h('a', { class: 'btn primary', href: '#/write' }, month ? '再写一封' : '写这个月的信'),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/letters' }, '所有的信'), h('a', { class: 'btn', href: '#/keep' }, '保管与备份')),
  );
  scrollTo(0, 0);
}

// ---------- 写信 ----------
async function write() {
  const today = D.todayStr();
  const choices = D.unlockChoices(box.birth, today);
  const def = choices.find((c) => c.age === 18) || choices[0];
  const draft = (await S.get('draft')) || { from: box.name, cover: '', text: '', unlockAt: def.date, qa: {}, files: [] };
  if (draft.unlockAt <= today) draft.unlockAt = def.date;
  const list = await S.letters();
  let saveTimer = 0;
  let pending = Promise.resolve();
  const saveNow = () => { clearTimeout(saveTimer); return (pending = pending.then(() => S.set('draft', draft)).catch((e) => toast('草稿没存上：' + e.message))); };
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };
  let rec = null;
  let sealed = false;
  leave = () => { if (rec) rec.cancel(); clearTimeout(saveTimer); if (!sealed) saveNow(); };

  // 寄信人
  const known = [...new Set([box.name, '爸爸', '妈妈', ...list.map((l) => l.from), draft.from])];
  const from = h('select', { onchange: () => {
    if (from.value === '+') {
      const n = (prompt('寄信人是谁？') || '').trim().slice(0, 20);
      if (n) from.prepend(h('option', { value: n }, n));
      from.value = n || draft.from;
    }
    draft.from = from.value; save(); refresh();
  } }, known.map((n) => h('option', { value: n }, n)), h('option', { value: '+' }, '其他人……'));
  from.value = draft.from;

  // 话题
  let pi = Math.floor(Math.random() * 100);
  const promptBox = h('p', { class: 'prompt' });
  const yearlyBox = h('div', {});
  function refresh() {
    const kid = draft.from === box.name;
    const ps = promptsFor(kid, D.ageOn(box.birth, today));
    promptBox.textContent = ps[pi % ps.length];
    // 每年一次的五个问题，只问孩子
    yearlyBox.replaceChildren();
    if (!kid) return;
    const d = h('details', { open: Object.values(draft.qa).some(Boolean) }, h('summary', {}, '每年五问（一年答一次，长大后并排看）'));
    for (const q of YEARLY) {
      d.append(field(q, h('textarea', { rows: 2, value: draft.qa[q] || '', oninput: (e) => { draft.qa[q] = e.target.value; save(); } })));
    }
    yearlyBox.append(d);
  }

  // 附件
  const fileBox = h('div', { class: 'files' });
  function showFiles() {
    fileBox.replaceChildren(...draft.files.map((f, i) => {
      const u = blobURL(f);
      return h('div', { class: 'file' },
        f.kind === 'audio' ? h('audio', { controls: true, src: u }) : h('img', { src: u, alt: f.kind === 'drawing' ? '画' : '照片' }),
        h('button', { type: 'button', class: 'small', onclick: () => { draft.files.splice(i, 1); saveNow(); showFiles(); } }, '去掉'));
    }));
  }
  const addFile = (f) => {
    if (!f.bytes.length) throw new Error('没有录到内容');
    if (draft.files.reduce((a, x) => a + x.bytes.length, f.bytes.length) > 25e6) throw new Error('一封信最多装 25 MB，分成两封吧');
    draft.files.push(f); saveNow(); showFiles();
  };

  const recBtn = act('🎙 录一段话', async () => {
    if (rec) { rec.finish(); return; }
    const r = await startRecording();
    if (!recBtn.isConnected) { r.stop(); return; }
    const t0 = Date.now();
    const label = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      recBtn.textContent = `■ 停止 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= MAX_SECONDS) rec?.finish();
    };
    const timer = setInterval(label, 500);
    const end = () => { clearInterval(timer); rec = null; recBtn.textContent = '🎙 录一段话'; recBtn.classList.remove('rec'); };
    rec = {
      async finish() { const stopping = r.stop(); end(); try { addFile(await stopping); } catch (e) { toast(e.message); } },
      cancel() { r.stop().then((f) => { if (f.bytes.length && !sealed) { draft.files.push(f); saveNow(); } }); end(); },
    };
    recBtn.classList.add('rec');
    label();
  });
  const photo = h('input', { type: 'file', accept: 'image/*', hidden: true, multiple: true, onchange: async () => {
    try { for (const f of photo.files) addFile(await loadPhoto(f)); } catch (e) { toast(e.message); }
    photo.value = '';
  } });
  const drawBox = h('div', {});
  const openDraw = () => {
    const c = h('canvas', { class: 'pad' });
    const pad = drawPad(c);
    drawBox.replaceChildren(c, h('div', { class: 'row' },
      ['#222a3a', '#c0392f', '#2a6fb0', '#2f8f57', '#e0a11b'].map((col) => h('button', { type: 'button', class: 'ink', style: `background:${col}`, 'aria-label': '换颜色', onclick: () => { pad.color = col; } })),
      act('清空', () => pad.clear(), 'small'),
      act('放进信里', async () => { if (!pad.used) throw new Error('还没画呢'); addFile(await pad.file()); drawBox.replaceChildren(); }, 'small'),
      act('不画了', () => drawBox.replaceChildren(), 'small')));
  };

  const text = h('textarea', { rows: 9, class: 'letter', placeholder: '写给长大以后的你……', value: draft.text, oninput: () => { draft.text = text.value; save(); } });
  const cover = h('input', { maxLength: 30, value: draft.cover, placeholder: '比如：掉了第一颗牙', oninput: () => { draft.cover = cover.value; save(); } });
  const date = h('input', { type: 'date', value: draft.unlockAt, min: D.addYears(today, 0), onchange: () => { if (date.value) { draft.unlockAt = date.value; save(); mark(); } } });
  const chips = h('div', { class: 'chips' }, choices.map((c) => h('button', { type: 'button', 'data-date': c.date, onclick: () => { draft.unlockAt = date.value = c.date; save(); mark(); } }, c.label)));
  const mark = () => chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.date === draft.unlockAt));
  mark();

  const pickBox = h('div', {});
  page('写一封信',
    h('div', { class: 'card' },
      field('谁来写', from),
      h('div', { class: 'promptrow' }, promptBox, h('button', { type: 'button', class: 'small', onclick: () => { pi++; refresh(); } }, '换一个话题')),
      text,
      h('div', { class: 'row' }, recBtn, h('button', { type: 'button', onclick: () => photo.click() }, '🖼 放照片'), h('button', { type: 'button', onclick: openDraw }, '✏️ 画一幅画'), h('button', { type: 'button', onclick: () => pickWork(pickBox, (w) => { text.value = draft.text = [draft.text, w].filter(Boolean).join('\n\n'); save(); }) }, '📝 出口成章的作文')),
      photo, pickBox, drawBox, fileBox, yearlyBox),
    h('div', { class: 'card' },
      field('信封上写几个字（不加密，别写秘密）', cover),
      h('p', { class: 'lbl' }, '什么时候拆'), chips, field('或者选一天', date),
      h('p', { class: 'note' }, '封好以后谁都不能改、不能删，到日子才能拆。草稿会自动保存在这台设备上。'),
      act('封好这封信', async () => {
        if (rec) throw new Error('先停止录音');
        const qa = draft.from === box.name ? YEARLY.filter((q) => draft.qa[q]?.trim()).map((q) => ({ q, a: draft.qa[q].trim() })) : [];
        if (!draft.text.trim() && !draft.files.length && !qa.length) throw new Error('信还是空的');
        if (draft.unlockAt <= D.todayStr()) throw new Error('拆信的日子要在今天以后');
        const l = await C.sealLetter(box, { id: C.todayStr() + '-' + C.toB64(C.rand(9)).replace(/[+/]/g, 'x'), from: draft.from, cover: draft.cover.trim(), createdAt: C.todayStr() + 'T' + new Date().toTimeString().slice(0, 8), unlockAt: draft.unlockAt }, { text: draft.text, qa, files: draft.files });
        await S.putLetter(l);
        sealed = true;
        clearTimeout(saveTimer);
        await pending;
        await S.del('draft');
        sealShow(l);
        autoPush();
      }, 'primary')));
  refresh();
  showFiles();
}

// 从《出口成章》带一篇作文进来：同一浏览器直接读，否则选它导出的备份文件
function pickWork(target, use) {
  const show = (works) => {
    const list = (Array.isArray(works) ? works : []).filter((w) => typeof w?.text === 'string' && w.text.trim()).slice(-30).reverse();
    target.replaceChildren(h('div', { class: 'works' }, list.length ? list.map((w) => h('button', { type: 'button', onclick: () => { use((w.title ? `《${w.title}》\n` : '') + w.text); target.replaceChildren(); } }, w.title || w.text.slice(0, 14)))
      : [h('p', { class: 'note' }, '这台设备上没找到作文。在《出口成章》的家长中心导出备份，再选那个文件：'),
        h('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
          try { const w = JSON.parse(await e.target.files[0].text()).works; if (!w?.length) throw 0; show(w); } catch { toast('这个文件里没有作文'); }
        } })]));
  };
  let works = [];
  try { works = JSON.parse(localStorage.getItem('kcz.v1') || '{}').works; } catch { /* 没有 */ }
  show(works);
}

function sealShow(l) {
  leave = null;
  main.replaceChildren(h('section', { class: 'hero seal' },
    h('div', { class: 'envelope big', 'aria-hidden': 'true' }, h('i')),
    h('h1', {}, '封好了'),
    h('p', {}, `${D.showDate(l.unlockAt)}拆开，${D.untilText(l.unlockAt)}。`),
    h('a', { class: 'btn primary', href: '#/' }, '去看看新的星星')));
  scrollTo(0, 0);
}

async function autoPush() {
  const gh = await S.get('github');
  if (!gh || !navigator.onLine) return;
  try { await pushAll(gh); toast('已备份到 GitHub'); } catch (e) { toast('自动备份没成功：' + e.message); }
}
async function pushAll(gh) {
  const list = await S.letters();
  const n = await makeClient(gh).push(box, list);
  await S.set('backup', { ids: list.map((l) => l.id), at: D.todayStr() });
  return n;
}

// ---------- 所有的信 ----------
async function lettersPage() {
  const today = D.todayStr();
  const list = (await S.letters()).reverse();
  const ready = list.filter((l) => l.unlockAt <= today);
  const row = (l) => {
    const can = l.unlockAt <= today;
    return h(can ? 'a' : 'div', { class: 'env' + (can ? ' can' : ''), href: can ? '#/open/' + l.id : null },
      h('b', {}, l.cover || `${l.from}的信`), h('span', {}, `${l.from} 写于 ${l.createdAt.slice(0, 10)}`), h('em', {}, D.untilText(l.unlockAt, today)));
  };
  const years = [...new Set(list.map((l) => l.createdAt.slice(0, 4)))];
  page('所有的信',
    ready.length ? h('a', { class: 'btn', href: '#/compare' }, '每年五问，并排看') : null,
    ...(list.length ? years.flatMap((y) => [h('h2', { class: 'year' }, `${y} 年`), ...list.filter((l) => l.createdAt.startsWith(y)).map(row)]) : [h('p', { class: 'empty' }, '还没有信。'), h('a', { class: 'btn primary', href: '#/write' }, '写第一封')]));
}
const askPass = (title, after) => {
  if (priv) return after();
  const p = h('input', { type: 'password', autocomplete: 'off' });
  page(title, h('div', { class: 'card' }, field('口令或恢复码', p), act('打开', async (b) => {
    b.textContent = '正在开锁……';
    try { remember((await C.unlockBox(box, p.value)).key); } finally { b.textContent = '打开'; }
    await after();
  }, 'primary')));
};

async function openPage(id) {
  const l = await S.letter(id);
  if (!l) return go('#/letters');
  if (l.unlockAt > D.todayStr()) { toast(`还没到日子，${D.untilText(l.unlockAt)}`); return go('#/letters'); }
  askPass('拆信', async () => {
    const c = await C.openLetter(priv, l);
    page(l.cover || '来信', h('article', { class: 'paper' },
      h('p', { class: 'meta' }, `${l.from}，写于 ${D.showDate(D.todayStr(new Date(l.createdAt)))}`),
      c.qa.map((x) => [h('p', { class: 'q' }, x.q), h('p', { class: 'txt' }, x.a)]).flat(),
      c.text ? h('p', { class: 'txt' }, c.text) : null,
      c.files.map((f) => (f.kind === 'audio' ? h('audio', { controls: true, src: blobURL(f) }) : h('img', { src: blobURL(f), alt: f.kind === 'drawing' ? '画' : '照片' })))));
  });
}

async function comparePage() {
  askPass('每年五问', async () => {
    const today = D.todayStr();
    const rows = new Map(YEARLY.map((q) => [q, []]));
    for (const l of await S.letters()) {
      if (l.unlockAt > today) continue;
      let c;
      try { c = await C.openLetter(priv, l); } catch { continue; }
      for (const x of c.qa) { if (!rows.has(x.q)) rows.set(x.q, []); rows.get(x.q).push([D.ageOn(box.birth, l.createdAt.slice(0, 10)), x.a]); }
    }
    const got = [...rows].filter(([, a]) => a.length);
    page('每年五问', ...(got.length ? got.map(([q, a]) => h('div', { class: 'paper' }, h('b', {}, q), h('dl', {}, a.map(([age, t]) => [h('dt', {}, `${age} 岁`), h('dd', {}, t)]).flat()))) : [h('p', { class: 'empty' }, '已经能拆的信里还没有五问的回答。')]));
  });
}

// ---------- 保管 ----------
async function keepPage() {
  const { list, backed, gh, checkAt } = await metaState();
  const years = [...new Set(list.map((l) => l.createdAt.slice(0, 4)))];
  const unsaved = list.filter((l) => !backed.ids.includes(l.id)).length;
  const size = list.reduce((a, l) => a + l.ct.length, 0);
  const pass = h('input', { type: 'password', autocomplete: 'off' });
  const oldP = h('input', { type: 'password', autocomplete: 'off' });
  const newP = h('input', { type: 'password', autocomplete: 'new-password' });
  const newP2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const result = h('p', { class: 'note', role: 'status' });
  page('保管与备份',
    h('div', { class: 'card' }, h('h2', {}, '存一份时光匣'),
      h('p', {}, `共 ${list.length} 封信，${(size / 1e6).toFixed(1)} MB。${unsaved ? `有 ${unsaved} 封还没备份。` : list.length ? `都已备份（${backed.at}）。` : ''}`),
      h('p', { class: 'note' }, '时光匣是一个能自己打开的网页文件，信是加密的。存到网盘、U 盘、家人的电脑，至少放两个地方。'),
      h('div', { class: 'row' }, act('存全部', () => saveTimebox(list, '全部'), 'primary'), years.length > 1 ? years.map((y) => act(`只存 ${y} 年`, () => saveTimebox(list.filter((l) => l.createdAt.startsWith(y)), y))) : null)),
    h('div', { class: 'card' }, h('h2', {}, '年度体检'),
      h('p', {}, `试着解开每一封信，但不显示内容，确认没有损坏，也确认你还记得口令。${checkAt ? `上次：${checkAt}` : ''}`),
      field('口令或恢复码', pass), act('开始体检', async () => {
        const { key } = await C.unlockBox(box, pass.value);
        pass.value = '';
        let bad = 0;
        for (const l of await S.letters()) { try { await C.openLetter(key, l); } catch { bad++; } }
        await S.set('checkAt', D.todayStr());
        result.textContent = bad ? `有 ${bad} 封信打不开，请从备份恢复到另一台设备再检查` : `${list.length} 封信全部完好，口令正确`;
      }), result),
    h('div', { class: 'card' }, h('h2', {}, '自动备份到 GitHub（可选）'),
      h('p', { class: 'note' }, '封好一封就自动传一份密文到你的私有仓库。令牌只存在这台设备上：在 GitHub 的 Settings → Developer settings → Fine-grained tokens 新建，只勾选那一个仓库，权限选 Contents: Read and write。'),
      githubForm(async (cfg) => { const n = await pushAll(cfg); await S.set('github', cfg); toast(`已备份，新上传 ${n} 封`); keepPage(); }, gh ? '保存并立即备份' : '连接并备份', gh || {}),
      gh ? act('断开', async () => { await S.del('github'); keepPage(); }) : null),
    h('div', { class: 'card' }, h('h2', {}, '合并另一台设备的信'), h('p', { class: 'note' }, '选另一台设备存出来的时光匣，缺的信会补进来。'), pickTimebox()),
    h('div', { class: 'card' }, h('h2', {}, '换口令'), field('现在的口令或恢复码', oldP), field('新口令', newP), field('再输一次新口令', newP2), act('换口令', async () => {
      if (C.normPass(newP.value).length < 8) throw new Error('口令至少 8 个字');
      if (C.normPass(newP.value) !== C.normPass(newP2.value)) throw new Error('两次口令不一样');
      const nb = { ...(await C.changePass(box, oldP.value, newP.value)), passAt: new Date().toISOString() };
      await S.set('box', nb);
      box = nb;
      await S.set('backup', { ids: [], at: null }); // 旧备份仍要用旧口令，提醒重新备份
      toast('换好了。旧的时光匣文件仍然要用旧口令，请重新存一份');
      keepPage();
    })),
  );
}

async function saveTimebox(list, label) {
  if (!list.length) throw new Error('还没有信');
  const html = buildTimebox(box, list, await loadSources(), D.todayStr());
  const file = new File([html], `时光匣-${box.name}-${label}-${D.todayStr()}.html`, { type: 'text/html' });
  if (navigator.maxTouchPoints > 1 && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    const u = URL.createObjectURL(file);
    h('a', { href: u, download: file.name }).click();
    setTimeout(() => URL.revokeObjectURL(u), 60e3);
  }
  const old = (await S.get('backup')) || { ids: [] };
  await S.set('backup', { ids: [...new Set([...old.ids, ...list.map((l) => l.id)])], at: D.todayStr() });
  toast('存好后，请打开文件试试口令');
  keepPage();
}

// ---------- 路由 ----------
async function route() {
  leave?.();
  leave = null;
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  try {
    if (!box) return welcome();
    const [, p, id] = location.hash.split('/');
    if (p === 'write') await write();
    else if (p === 'letters') await lettersPage();
    else if (p === 'open') await openPage(decodeURIComponent(id || ''));
    else if (p === 'compare') await comparePage();
    else if (p === 'keep') await keepPage();
    else await home();
  } catch (e) { toast(e.message || '出错了'); }
}
addEventListener('hashchange', route);
addEventListener('pagehide', () => leave?.());

try { box = (await S.get('box')) || null; } catch { toast('这个浏览器不允许保存数据（可能是无痕模式）'); }
route();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

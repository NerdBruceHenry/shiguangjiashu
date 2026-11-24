import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/crypto.js';
import * as D from '../js/dates.js';
import { buildTimebox, parseTimebox } from '../js/backup.js';
import { makeClient } from '../js/github.js';

const IT = 1000; // 测试用较少的迭代次数
const code = C.newRecoveryCode();
const box = await C.createBox({ name: '小豆', birth: '2018-05-20', passAt: '2026-01-01' }, '春天的小豆豆', code, IT);
const key = (await C.unlockBox(box, '春天的小豆豆')).key;
const meta = (id = 'abcd1234', over = {}) => ({ id, from: '妈妈', cover: '第一颗牙', createdAt: '2026-01-01T00:00:00Z', unlockAt: '2036-05-20', ...over });
const bytes = C.rand(60000);
const content = { text: '你好，未来 🌱</script><b>', qa: [{ q: 'Q', a: 'A' }], files: [{ kind: 'audio', mime: 'audio/mp4', bytes }, { kind: 'drawing', mime: 'image/png', bytes: C.rand(10) }] };

test('封信、拆信内容一致（含附件）', async () => {
  const o = await C.openLetter(key, await C.sealLetter(box, meta(), content));
  assert.equal(o.text, content.text);
  assert.deepEqual(o.qa, content.qa);
  assert.deepEqual(o.files[0].bytes, bytes);
  assert.equal(o.files.length, 2);
});

test('恢复码能开，大小写和横线不影响；错误口令打不开', async () => {
  assert.match(code, /^([2-9A-HJKMNP-TV-Z]{5}-){4}[2-9A-HJKMNP-TV-Z]{5}$/);
  await C.unlockBox(box, code);
  await C.unlockBox(box, ' ' + code.toLowerCase().replaceAll('-', ' '));
  for (const p of ['春天的小豆', '', code.slice(0, -1)]) await assert.rejects(C.unlockBox(box, p), /口令/);
});

test('改日期、寄信人、信封、密文都会被发现', async () => {
  const l = await C.sealLetter(box, meta(), content);
  for (const over of [{ unlockAt: '2020-01-01' }, { from: '爸爸' }, { cover: 'x' }, { createdAt: 'x' }, { id: 'zzzz9999' }]) {
    await assert.rejects(C.openLetter(key, { ...l, ...over }), /损坏/);
  }
  const ct = l.ct.slice(); ct[9] ^= 1;
  await assert.rejects(C.openLetter(key, { ...l, ct }), /损坏/);
});

test('信箱和信件里没有明文', async () => {
  const l = await C.sealLetter(box, meta(), { text: 'PLAINTEXTMARK' });
  assert.ok(!Buffer.from(l.ct).includes('PLAINTEXTMARK'));
  assert.ok(!JSON.stringify(box).includes(code));
});

test('换口令：旧信能用新口令开，旧口令失效，恢复码仍有效', async () => {
  const l = await C.sealLetter(box, meta(), content);
  const nb = await C.changePass(box, code, '新的口令一二三', IT);
  assert.equal((await C.openLetter((await C.unlockBox(nb, '新的口令一二三')).key, l)).text, content.text);
  await assert.rejects(C.unlockBox(nb, '春天的小豆豆'));
  await C.unlockBox(nb, code);
});

const src = () => ({ crypto: readFileSync('js/crypto.js', 'utf8'), reader: readFileSync('js/reader.js', 'utf8'), template: readFileSync('reader.template.html', 'utf8') });

test('时光匣能存能读，内嵌脚本语法正确且没有 import/export', async () => {
  const evil = await C.sealLetter(box, meta('evil0001', { cover: '</script><script>alert(1)</script>$&' }), content);
  const html = buildTimebox(box, [evil], src(), '2026-11-24');
  assert.equal(html.match(/<\/script>/g).length, 2);
  const back = parseTimebox(html);
  assert.deepEqual(back.box, box);
  assert.equal((await C.openLetter(key, back.letters[0])).text, content.text);
  const js = html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  assert.doesNotMatch(js, /^(import|export) /m);
  new Function(js);
  assert.throws(() => parseTimebox('<html></html>'), /不是/);
});

test('日期：生日、闰日、倒计时', () => {
  assert.equal(D.addYears('2008-02-29', 18), '2026-03-01');
  assert.equal(D.ageOn('2018-05-20', '2026-05-19'), 7);
  assert.equal(D.ageOn('2018-05-20', '2026-05-20'), 8);
  assert.equal(D.untilText('2026-11-24', '2026-11-24'), '可以拆了');
  assert.equal(D.untilText('2026-11-25', '2026-11-24'), '还有 1 天');
  assert.equal(D.untilText('2036-05-20', '2026-11-24'), '还有 9 年 5 个月');
  assert.equal(D.untilText('2027-11-24', '2026-11-24'), '还有 1 年');
  assert.ok(D.unlockChoices('2018-05-20', '2026-11-24').every((c) => c.date > '2026-11-24'));
});

function fakeGitHub({ priv = true } = {}) {
  const files = new Map();
  let puts = 0;
  const f = async (url, o = {}) => {
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    const p = url.split('/repos/a/b')[1];
    if (p === '') return json({ private: priv, default_branch: 'main' });
    if (p.startsWith('/git/trees/')) return files.size ? json({ tree: [...files.keys()].map((k) => ({ type: 'blob', path: k, sha: 's' + k })) }) : json({}, 409);
    if (p.startsWith('/git/blobs/')) return json({ content: files.get(p.slice(12)) });
    if (o.method === 'PUT') { const k = p.slice(10); const b = JSON.parse(o.body); if (files.has(k) && !b.sha) return json({}, 422); files.set(k, b.content); puts++; return json({}, 201); }
    return json({}, 404);
  };
  return { f, files, puts: () => puts };
}

test('GitHub 备份：只传新信、能恢复、拒绝公开仓库、不会用旧口令覆盖新口令', async () => {
  const g = fakeGitHub();
  const c = makeClient({ repo: 'a/b', token: 't' }, g.f);
  const l1 = await C.sealLetter(box, meta('letter01'), content);
  assert.equal(await c.push(box, [l1]), 1);
  assert.equal(await c.push(box, [l1]), 0);
  assert.equal(g.puts(), 2);
  const back = await c.pull();
  assert.equal((await C.openLetter(key, back.letters[0])).text, content.text);
  const newer = { ...(await C.changePass(box, code, '新的口令一二三', IT)), passAt: '2026-06-01' };
  await c.push(newer, [l1]);
  await c.push(box, [l1]);
  assert.deepEqual((await c.pull()).box, newer);
  await assert.rejects(makeClient({ repo: 'a/b', token: 't' }, fakeGitHub({ priv: false }).f).push(box, []), /私有/);
  assert.throws(() => makeClient({ repo: 'bad', token: '' }));
});

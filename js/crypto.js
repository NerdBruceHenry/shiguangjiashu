// 时光家书的加密核心。只用浏览器自带的 WebCrypto，没有任何第三方库。
// 这个文件会被原样嵌进「时光匣」备份网页，所以不能 import 别的文件。
//
// 投信箱模型：封信只需要公钥（谁都能投），拆信需要私钥（只有口令或恢复码能解开）。
//   封信：临时 ECDH P-256 密钥 + 信箱公钥 → HKDF → AES-256-GCM
//   私钥：分别用「口令」和「恢复码」经 PBKDF2-SHA256 派生的密钥加密保存
export const FORMAT = 1;
export const ITER = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // 去掉易混的 0 O 1 I L U

export function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function newRecoveryCode() {
  // 25 位，每位 30 种取值，约 122 比特
  let s = '';
  while (s.length < 25) {
    for (const b of rand(32)) if (b < 240 && s.length < 25) s += ALPHABET[b % 30];
  }
  return s.match(/.{5}/g).join('-');
}

// 口令：去掉首尾空白并统一全角/半角写法；恢复码：忽略大小写、横线和空格
export function normPass(p) { return p.normalize('NFKC').trim(); }
export function normCode(c) { return c.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, ''); }

async function passKey(secret, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrap(secret, pkcs8, iter) {
  const salt = rand(16);
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(secret, salt, iter), pkcs8);
  return { salt: toB64(salt), iv: toB64(iv), iter, ct: toB64(new Uint8Array(ct)) };
}

async function unwrap(w, secret) {
  const k = await passKey(secret, fromB64(w.salt), w.iter);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.iv) }, k, fromB64(w.ct)));
}

// 新建信箱。info 是孩子的称呼、生日等不保密的信息。
export async function createBox(info, pass, code, iter = ITER) {
  const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    v: FORMAT,
    id: toB64(rand(9)).replace(/[+/]/g, 'x'),
    ...info,
    pub: toB64(pub),
    byPass: await wrap(normPass(pass), pkcs8, iter),
    byCode: await wrap(normCode(code), pkcs8, iter),
  };
}

// 用口令或恢复码取出私钥；都不对时抛错
export async function unlockBox(box, secret) {
  for (const [w, s] of [[box.byPass, normPass(secret)], [box.byCode, normCode(secret)]]) {
    if (!s) continue;
    let pkcs8;
    try { pkcs8 = await unwrap(w, s); } catch { continue; }
    return { pkcs8, key: await crypto.subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits']) };
  }
  throw new Error('口令或恢复码不对');
}

// 换口令（旧信不用重新加密）
export async function changePass(box, secret, newPass, iter = ITER) {
  const { pkcs8 } = await unlockBox(box, secret);
  return { ...box, byPass: await wrap(normPass(newPass), pkcs8, iter) };
}

// 信封上的字参与校验：改了拆封日期或寄信人，信就打不开
function aad(l) {
  return enc.encode(JSON.stringify([l.v, l.id, l.boxId, l.from, l.cover, l.createdAt, l.unlockAt]));
}

async function letterKey(priv, pubRaw, salt) {
  const pub = await crypto.subtle.importKey('raw', pubRaw, EC, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('shiguangjiashu-letter') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// content: { text, qa, files:[{kind,mime,bytes:Uint8Array}] }
export function pack(content) {
  const files = content.files || [];
  const head = enc.encode(JSON.stringify({ text: content.text || '', qa: content.qa || [], files: files.map((f) => ({ kind: f.kind, mime: f.mime, len: f.bytes.length })) }));
  const out = new Uint8Array(4 + head.length + files.reduce((a, f) => a + f.bytes.length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let p = 4 + head.length;
  for (const f of files) { out.set(f.bytes, p); p += f.bytes.length; }
  return out;
}

export function unpack(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const head = JSON.parse(dec.decode(bytes.subarray(4, 4 + n)));
  let p = 4 + n;
  head.files = head.files.map((f) => {
    const b = bytes.slice(p, p + f.len);
    p += f.len;
    return { kind: f.kind, mime: f.mime, bytes: b };
  });
  return head;
}

export async function sealLetter(box, meta, content) {
  const l = { v: FORMAT, id: meta.id, boxId: box.id, from: meta.from, cover: meta.cover || '', createdAt: meta.createdAt, unlockAt: meta.unlockAt };
  const eph = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const iv = rand(12);
  const key = await letterKey(eph.privateKey, fromB64(box.pub), ephRaw);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(l) }, key, pack(content));
  return { ...l, eph: toB64(ephRaw), iv: toB64(iv), ct: new Uint8Array(ct) };
}

export async function openLetter(privKey, l) {
  let pt;
  try {
    const eph = fromB64(l.eph);
    const key = await letterKey(privKey, eph, eph);
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(l.iv), additionalData: aad(l) }, key, l.ct);
  } catch { throw new Error('这封信损坏或被改动过'); }
  return unpack(new Uint8Array(pt));
}

export function letterToJSON(l) { return { ...l, ct: toB64(l.ct) }; }
export function letterFromJSON(j) {
  for (const k of ['id', 'boxId', 'from', 'createdAt', 'unlockAt', 'eph', 'iv', 'ct']) {
    if (typeof j?.[k] !== 'string') throw new Error('信件格式不对');
  }
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(j.id) || !/^\d{4}-\d\d-\d\d$/.test(j.unlockAt)) throw new Error('信件格式不对');
  return { v: j.v, id: j.id, boxId: j.boxId, from: j.from, cover: String(j.cover ?? ''), createdAt: j.createdAt, unlockAt: j.unlockAt, eph: j.eph, iv: j.iv, ct: fromB64(j.ct) };
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

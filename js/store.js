// 本机存储（IndexedDB）。信件只以密文保存；草稿是明文，封好后立即删除。
let dbp;
function open() {
  return (dbp ??= new Promise((ok, bad) => {
    const r = indexedDB.open('sgjs', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('letters', { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  }));
}
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((ok, bad) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = tx.onabort = () => bad(tx.error || new Error('存储失败'));
  });
}
export const get = (k) => run('kv', 'readonly', (s) => s.get(k));
export const set = (k, v) => run('kv', 'readwrite', (s) => s.put(v, k));
export const del = (k) => run('kv', 'readwrite', (s) => s.delete(k));
export const letters = async () => (await run('letters', 'readonly', (s) => s.getAll())).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
export const letter = (id) => run('letters', 'readonly', (s) => s.get(id));
export const putLetter = (l) => run('letters', 'readwrite', (s) => s.put(l));

// 恢复备份：同一封信已存在就保留本机的
export async function mergeLetters(list) {
  const have = new Set((await letters()).map((l) => l.id));
  const add = list.filter((l) => !have.has(l.id));
  for (const l of add) await putLetter(l);
  return add.length;
}

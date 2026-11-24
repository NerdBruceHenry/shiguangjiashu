// 可选：把密文自动备份到家长自己的「私有」GitHub 仓库。每封信一个文件，只增不改。
import { letterToJSON, letterFromJSON, toB64, fromB64 } from './crypto.js';

const API = 'https://api.github.com';

export function makeClient({ repo, token }, f = globalThis.fetch.bind(globalThis)) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('仓库名格式应为 用户名/仓库名');
  const call = (path, opt = {}) => f(`${API}/repos/${repo}${path}`, {
    ...opt,
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const fail = (r) => new Error({ 401: '访问令牌无效或过期', 403: '令牌没有这个仓库的写入权限', 404: '找不到仓库（检查仓库名和令牌权限）' }[r.status] || `GitHub 出错（${r.status}）`);
  const put = async (path, text, sha) => {
    const r = await call(`/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message: `backup ${path}`, content: toB64(new TextEncoder().encode(text)), ...(sha ? { sha } : {}) }) });
    if (!r.ok) throw fail(r);
  };
  const blob = async (sha) => {
    const r = await call(`/git/blobs/${sha}`);
    if (!r.ok) throw fail(r);
    return new TextDecoder().decode(fromB64((await r.json()).content.replace(/\s/g, '')));
  };
  const tree = async () => {
    const info = await call('');
    if (!info.ok) throw fail(info);
    const j = await info.json();
    if (!j.private) throw new Error('为了安全，只能备份到私有（Private）仓库');
    const r = await call(`/git/trees/${j.default_branch}?recursive=1`);
    if (r.status === 404 || r.status === 409) return []; // 空仓库
    if (!r.ok) throw fail(r);
    const t = await r.json();
    if (t.truncated) throw new Error('仓库文件太多，无法完整列出');
    return t.tree.filter((x) => x.type === 'blob');
  };
  return {
    async push(box, list) {
      const have = new Map((await tree()).map((x) => [x.path, x.sha]));
      const bp = `${box.id}/box.json`;
      const text = JSON.stringify(box);
      if (!have.has(bp)) await put(bp, text);
      else {
        const old = await blob(have.get(bp));
        // 另一台设备换过口令时，不要用旧的盖掉
        if (old !== text && !((JSON.parse(old).passAt || '') > (box.passAt || ''))) await put(bp, text, have.get(bp));
      }
      let n = 0;
      for (const l of list) {
        const p = `${box.id}/letters/${l.id}.json`;
        if (have.has(p)) continue;
        await put(p, JSON.stringify(letterToJSON(l)));
        n++;
      }
      return n;
    },
    async pull() {
      const files = await tree();
      const b = files.filter((x) => /^[^/]+\/box\.json$/.test(x.path));
      if (!b.length) throw new Error('这个仓库里没有时光家书备份');
      if (b.length > 1) throw new Error('仓库里有多个信箱，请每个信箱用单独的仓库');
      const box = JSON.parse(await blob(b[0].sha));
      const out = [];
      for (const x of files) if (x.path.startsWith(`${box.id}/letters/`)) out.push(letterFromJSON(JSON.parse(await blob(x.sha))));
      return { box, letters: out };
    },
  };
}

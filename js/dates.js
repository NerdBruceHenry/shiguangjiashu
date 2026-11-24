import { todayStr } from './crypto.js';

export { todayStr };
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

export function addYears(s, n) { const d = parse(s); d.setFullYear(d.getFullYear() + n); return todayStr(d); }

export function ageOn(birth, day) {
  let a = Number(day.slice(0, 4)) - Number(birth.slice(0, 4));
  if (day < addYears(birth, a)) a--;
  return a;
}

export function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }

export function untilText(unlockAt, now = todayStr()) {
  if (unlockAt <= now) return '可以拆了';
  const days = daysBetween(now, unlockAt);
  if (days < 60) return `还有 ${days} 天`;
  let y = 0;
  while (addYears(now, y + 1) <= unlockAt) y++;
  const m = Math.min(Math.floor(daysBetween(addYears(now, y), unlockAt) / 30.44), 11);
  return `还有${y ? ` ${y} 年` : ''}${m ? ` ${m} 个月` : ''}`;
}

export function showDate(s) { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${y} 年 ${m} 月 ${d} 日`; }

// 拆封日期的快捷选项（默认 18 岁生日）
export function unlockChoices(birth, today = todayStr()) {
  const out = [];
  for (const age of [10, 12, 15, 18, 30]) {
    const date = addYears(birth, age);
    if (date > today) out.push({ label: `${age} 岁生日`, date, age });
  }
  out.push({ label: '一年后的今天', date: addYears(today, 1) });
  return out;
}

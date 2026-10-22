/**
 * 复习「推后」表（docs/review.md「没打分的卡排到后面」）：一轮里出现过但没打分就离开的卡
 * （跳过 / 中途退出时正显示的那张）记一个时间戳，下次开始复习时排到其它到期卡后面。
 * 只存 localStorage `linguaclip_review_deferred`（`{ [cardId]: 时间戳 }`），不动卡片、不改排期。
 */
const KEY = 'linguaclip_review_deferred';
const MAX = 1000;

export type Deferred = Record<string, number>;

// 读不出 / JSON 坏 / 没有 localStorage（node）→ 空表，回到旧顺序。
export const readDeferred = (): Deferred => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};

// 写失败不挡复习；只留最近 MAX 条。
export const deferCard = (id: string, now = Date.now()) => {
  try {
    const all = { ...readDeferred(), [id]: now };
    const kept = Object.entries(all).filter(([, t]) => typeof t === 'number').sort((a, b) => b[1] - a[1]).slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch (e) { console.error(e); }
};

// 生效的推后时间：晚于这张卡上次打分才算（打过分旧记录自动失效）；不生效 = undefined。
export const deferredAt = (deferred: Deferred, id: string, lastReview: number | undefined) => {
  const t = deferred[id];
  return typeof t === 'number' && t > (lastReview ?? 0) ? t : undefined;
};

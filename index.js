/**
 * Host half of dsh-live-pricing.
 *
 * 浏览器端拿不到「整段会话」的用量——会话窗口是分页的，节点经常凑不齐，用窗口
 * 里的节点按峰谷分段会算错（这正是 0.1.x 金额对不上的根因）。所以把「按峰谷分桶
 * 累计 token」这件事放到 Host 端：登记一个只读的 session projection，逐条把
 * `assistant/message` 的 usage 按**该事件的发生时刻**记进高峰桶或空闲桶，
 * 浏览器端再用对应时段的单价计价。整段日志折叠，分页与压缩都不影响结果。
 *
 * 这里只登记一个投影：不注册工具、不注入提示词、不联网、不写任何文件，
 * 模型的每一次请求与不装该插件时完全一致。
 */

/* ==================================================================
 * 北京时间与峰谷判定（与 client.js 保持同一套规则）
 * ================================================================== */

/** 2026 年中国法定节假日（国办发明电〔2025〕7 号）。 */
const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const HOLIDAYS = (function buildHolidays() {
  const set = new Set();
  const DAY = 86400000;
  for (const range of HOLIDAY_RANGES) {
    const start = Date.parse(range[0] + 'T00:00:00Z');
    const end = Date.parse(range[1] + 'T00:00:00Z');
    for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
})();

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const PEAK_WINDOWS = [[540, 720], [840, 1080]];

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hh: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

/** 事件发生时刻是否处于高峰时段。时刻未知时按空闲处理（保守，不会高估）。 */
function isPeakInstant(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return false;
  const p = beijingParts(ms);
  if (p.wd === 0 || p.wd === 6) return false;
  const key = String(p.y) + '-' + pad2(p.mo) + '-' + pad2(p.day);
  if (HOLIDAYS.has(key)) return false;
  const minutes = p.hh * 60 + p.mi;
  for (const window of PEAK_WINDOWS) {
    if (minutes >= window[0] && minutes < window[1]) return true;
  }
  return false;
}

/* ==================================================================
 * 分桶累计
 * ================================================================== */
function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function countOf(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function bucketsOf(usage) {
  return {
    uncachedInputTokens: countOf(usage.inputTokens),
    outputTokens: countOf(usage.outputTokens),
    cacheReadTokens: countOf(usage.cacheReadTokens),
    cacheWriteTokens: countOf(usage.cacheWriteTokens),
  };
}

function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens;
}

function bucketsEmpty(b) {
  return b.uncachedInputTokens === 0 && b.outputTokens === 0 && b.cacheReadTokens === 0 && b.cacheWriteTokens === 0;
}

function addBuckets(base, add) {
  return {
    uncachedInputTokens: base.uncachedInputTokens + add.uncachedInputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    cacheReadTokens: base.cacheReadTokens + add.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + add.cacheWriteTokens,
  };
}

function subBuckets(base, sub) {
  return {
    uncachedInputTokens: Math.max(0, base.uncachedInputTokens - sub.uncachedInputTokens),
    outputTokens: Math.max(0, base.outputTokens - sub.outputTokens),
    cacheReadTokens: Math.max(0, base.cacheReadTokens - sub.cacheReadTokens),
    cacheWriteTokens: Math.max(0, base.cacheWriteTokens - sub.cacheWriteTokens),
  };
}

/** 本次会话某一条 settlement 的上报用量；没有上报就返回 undefined。 */
function usageOf(event) {
  const data = event.data;
  if (data === undefined || data === null) return undefined;
  if (event.type === 'assistant/message') {
    return data.usage === undefined || data.usage === null ? undefined : data.usage;
  }
  if (event.type === 'assistant/attempt') {
    return data.usage === undefined || data.usage === null ? undefined : data.usage;
  }
  return undefined;
}

/* ==================================================================
 * 最简 schema：session projection 要求 stateSchema / viewSchema 带 parse()。
 * 这里做真实校验（而不是 zod 依赖），数据形状不对就直接抛，便于暴露问题。
 * ================================================================== */
function bucketSchema(label) {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object') throw new Error(label + ' 必须是对象');
      for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        const field = value[key];
        if (!Number.isSafeInteger(field) || field < 0) throw new Error(label + '.' + key + ' 必须是非负整数');
      }
      return value;
    },
  };
}

const BUCKETS = bucketSchema('buckets');

const stateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new Error('state 必须是对象');
    BUCKETS.parse(value.peak);
    BUCKETS.parse(value.offPeak);
    const last = value.last;
    if (last !== null && last !== undefined) {
      if (typeof last !== 'object') throw new Error('state.last 必须是对象或 null');
      if (typeof last.turn !== 'number' || typeof last.step !== 'number') throw new Error('state.last 缺少 turn/step');
      if (last.band !== 'peak' && last.band !== 'offPeak') throw new Error('state.last.band 取值非法');
      BUCKETS.parse(last.buckets);
    }
    if (!Number.isSafeInteger(value.sampled) || value.sampled < 0) throw new Error('state.sampled 必须是非负整数');
    return value;
  },
};

const viewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new Error('view 必须是对象');
    BUCKETS.parse(value.peak);
    BUCKETS.parse(value.offPeak);
    if (!Number.isSafeInteger(value.sampled) || value.sampled < 0) throw new Error('view.sampled 必须是非负整数');
    return value;
  },
};

/* ==================================================================
 * 投影单元：整段日志按事件时刻折叠进高峰 / 空闲两个桶
 * ================================================================== */
export const PRICING_PROJECTION_KEY = 'deepseekLivePricing';

export const pricingProjection = {
  key: PRICING_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: stateSchema,
  init: function init() {
    return { peak: zeroBuckets(), offPeak: zeroBuckets(), last: null, sampled: 0 };
  },
  apply: function apply(state, event) {
    // 重试会重采样同一个 turn:step，先把上一次的样本从它所属的桶里撤掉。
    if (event.type === 'llm/retry-started') {
      const data = event.data;
      if (state.last === null || state.last.turn !== data.turn || state.last.step !== data.step) return state;
      const cleared = state.last.band === 'peak'
        ? { peak: subBuckets(state.peak, state.last.buckets), offPeak: state.offPeak }
        : { peak: state.peak, offPeak: subBuckets(state.offPeak, state.last.buckets) };
      return { ...state, peak: cleared.peak, offPeak: cleared.offPeak, last: null, sampled: state.sampled + 1 };
    }

    const usage = usageOf(event);
    if (usage === undefined) return state;

    const data = event.data;
    const turn = typeof data.turn === 'number' ? data.turn : -1;
    const step = typeof data.step === 'number' ? data.step : -1;
    const band = isPeakInstant(event.time) ? 'peak' : 'offPeak';
    const buckets = bucketsOf(usage);

    // 同一个 turn:step 的重采样：替换而不是累加。
    const replacing = state.last !== null && state.last.turn === turn && state.last.step === step;
    if (replacing && state.last.band === band && bucketsEqual(state.last.buckets, buckets)) return state;

    let peak = state.peak;
    let offPeak = state.offPeak;
    if (replacing) {
      if (state.last.band === 'peak') peak = subBuckets(peak, state.last.buckets);
      else offPeak = subBuckets(offPeak, state.last.buckets);
    }
    if (band === 'peak') peak = addBuckets(peak, buckets);
    else offPeak = addBuckets(offPeak, buckets);

    if (bucketsEmpty(buckets) && !replacing) return state;

    return { peak: peak, offPeak: offPeak, last: { turn: turn, step: step, band: band, buckets: buckets }, sampled: state.sampled + 1 };
  },
  wire: {
    viewSchema: viewSchema,
    view: function view(state) {
      return { peak: state.peak, offPeak: state.offPeak, sampled: state.sampled };
    },
  },
};

/**
 * 登记投影。缺少 sessionProjections 服务时静默跳过——客户端会退回
 * `tokenUsage` 投影做整体估算，而不是整个插件失效。
 *
 * @param {object} ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  let registry;
  try {
    registry = ctx.get('sessionProjections', false);
  } catch (error) {
    registry = undefined;
  }
  if (registry === undefined || registry === null || typeof registry.register !== 'function') {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[dsh-live-pricing] sessionProjections 服务不可用，客户端将退回估算模式');
    }
    return;
  }
  registry.register(pricingProjection);
}

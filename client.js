/**
 * DeepSeek 实时价格 / 时段 / 节假日 / 会话消耗 —— Client half。
 *
 * 渲染到会话输入框下方的 `conversation.composer.dock` 席位（与官方统计条并列），
 * 每秒刷新一次时钟与倒计时，并随会话投影变化实时更新花费。
 *
 * 它回答四件事：
 *   1. 现在（北京时间）是高峰时段还是空闲时段，下一次切换还有多久；
 *   2. 今天是不是中国法定节假日，距下一个节假日还有多久；
 *   3. 当前模型此刻生效的实时单价（缓存命中输入 / 缓存未命中输入 / 输出）；
 *   4. 本次会话已经花掉多少钱（按 token 分桶逐项计价）。
 *
 * 价目来源：DeepSeek 官方 API 文档《模型 & 价格》
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 规则：高峰时段 = 北京时间 周一至周五（不含中国法定节假日）
 *       09:00-12:00 与 14:00-18:00；其余时段（含周末与法定节假日全天）
 *       为空闲时段，空闲价 = 高峰价的 50%。
 *
 * 会话 token 用量来自内置的 `tokenUsage` 会话投影（整段日志折叠，分页/压缩不影响），
 * 当前模型来自 `modelSelection` 会话投影。
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-pricing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'deepseek-pricing';

    /* ==================================================================
     * 1. 价目表（人民币 / 每百万 tokens）
     * ================================================================== */
    const PRICE_TABLE = {
      'deepseek-flash': {
        label: 'DeepSeek-V4.1-Flash',
        cacheHit: { peak: 0.04, offPeak: 0.02 },
        cacheMiss: { peak: 2.0, offPeak: 1.0 },
        output: { peak: 8.0, offPeak: 4.0 },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek-V4-Pro',
        cacheHit: { peak: 0.3, offPeak: 0.15 },
        cacheMiss: { peak: 9.0, offPeak: 4.5 },
        output: { peak: 27.0, offPeak: 13.5 },
      },
    };
    /** 官方文档点名的旧模型名，仍按 Flash 计费。 */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };
    const DEFAULT_MODEL = 'deepseek-flash';
    const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
    const PRICE_CHECKED_AT = '2026-09-30';

    /* ==================================================================
     * 2. 中国法定节假日（2026，国办发明电〔2025〕7 号）
     *    高峰时段排除法定节假日；调休上班的周末仍是周末，本来就空闲。
     * ================================================================== */
    const HOLIDAY_RANGES = [
      ['2026-01-01', '2026-01-03', '元旦'],
      ['2026-02-15', '2026-02-23', '春节'],
      ['2026-04-04', '2026-04-06', '清明节'],
      ['2026-05-01', '2026-05-05', '劳动节'],
      ['2026-06-19', '2026-06-21', '端午节'],
      ['2026-09-25', '2026-09-27', '中秋节'],
      ['2026-10-01', '2026-10-07', '国庆节'],
    ];
    const HOLIDAYS = (function buildHolidays() {
      const map = new Map();
      const DAY = 86400000;
      for (let i = 0; i < HOLIDAY_RANGES.length; i += 1) {
        const range = HOLIDAY_RANGES[i];
        const start = Date.parse(range[0] + 'T00:00:00Z');
        const end = Date.parse(range[1] + 'T00:00:00Z');
        for (let t = start; t <= end; t += DAY) {
          map.set(new Date(t).toISOString().slice(0, 10), range[2]);
        }
      }
      return map;
    })();

    /* ==================================================================
     * 3. 北京时间与高峰时段判定
     *    北京时间为固定 UTC+8，无夏令时，所以直接位移后读 UTC 字段。
     * ================================================================== */
    const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
    const PEAK_WINDOWS = [[540, 720], [840, 1080]]; // 分钟数：09:00-12:00 / 14:00-18:00
    const DAY_BOUNDARIES = [0, 540, 720, 840, 1080];

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
        sec: d.getUTCSeconds(),
        wd: d.getUTCDay(), // 0 = 周日
      };
    }

    function dayKey(p) {
      return String(p.y) + '-' + pad2(p.mo) + '-' + pad2(p.day);
    }

    /** 北京墙上时间 -> 真实时刻（毫秒）。 */
    function beijingInstant(y, mo, day, hh, mi) {
      return Date.UTC(y, mo - 1, day, hh - 8, mi, 0, 0);
    }

    function isHolidayKey(key) {
      return HOLIDAYS.has(key);
    }

    function isPeakInstant(ms) {
      const p = beijingParts(ms);
      if (p.wd === 0 || p.wd === 6) return false;
      if (isHolidayKey(dayKey(p))) return false;
      const minutes = p.hh * 60 + p.mi;
      for (let i = 0; i < PEAK_WINDOWS.length; i += 1) {
        if (minutes >= PEAK_WINDOWS[i][0] && minutes < PEAK_WINDOWS[i][1]) return true;
      }
      return false;
    }

    /** 下一次「高峰 <-> 空闲」状态翻转的时刻。 */
    function nextBandChange(ms) {
      const current = isPeakInstant(ms);
      const p = beijingParts(ms);
      for (let offset = 0; offset <= 15; offset += 1) {
        const anchor = beijingParts(beijingInstant(p.y, p.mo, p.day + offset, 12, 0));
        for (let i = 0; i < DAY_BOUNDARIES.length; i += 1) {
          const boundary = DAY_BOUNDARIES[i];
          const at = beijingInstant(
            anchor.y,
            anchor.mo,
            anchor.day,
            Math.floor(boundary / 60),
            boundary % 60,
          );
          if (at <= ms) continue;
          if (isPeakInstant(at) !== current) return { at: at, becomesPeak: !current };
        }
      }
      return null;
    }

    /** 从当前时刻起，下一次进入指定时段（高峰/空闲）的时刻。 */
    function nextBandStart(ms, wantPeak) {
      const p = beijingParts(ms);
      for (let offset = 0; offset <= 15; offset += 1) {
        const anchor = beijingParts(beijingInstant(p.y, p.mo, p.day + offset, 12, 0));
        for (let i = 0; i < DAY_BOUNDARIES.length; i += 1) {
          const boundary = DAY_BOUNDARIES[i];
          const at = beijingInstant(
            anchor.y,
            anchor.mo,
            anchor.day,
            Math.floor(boundary / 60),
            boundary % 60,
          );
          if (at <= ms) continue;
          if (isPeakInstant(at) === wantPeak) return at;
        }
      }
      return null;
    }

    /** 当前时段画像：高峰与否、节假日、周末、以及"为什么"。 */
    function phaseOf(ms) {
      const p = beijingParts(ms);
      const key = dayKey(p);
      const holidayName = HOLIDAYS.get(key) || null;
      const weekend = p.wd === 0 || p.wd === 6;
      const minutes = p.hh * 60 + p.mi;
      let reason;
      if (holidayName !== null) reason = 'holiday';
      else if (weekend) reason = 'weekend';
      else if (minutes < 540) reason = 'weekday-before';
      else if (minutes < 720) reason = 'weekday-am';
      else if (minutes < 840) reason = 'weekday-lunch';
      else if (minutes < 1080) reason = 'weekday-pm';
      else reason = 'weekday-night';
      return {
        peak: isPeakInstant(ms),
        holidayName: holidayName,
        weekend: weekend,
        reason: reason,
        dateKey: key,
        clock:
          pad2(p.hh) + ':' + pad2(p.mi) + ':' + pad2(p.sec),
        dateText: key + ' 周' + '日一二三四五六'.charAt(p.wd),
      };
    }

    /** 下一个法定节假日；今天是节假日时直接返回今天。 */
    function nextHoliday(ms) {
      const p = beijingParts(ms);
      const todayKey = dayKey(p);
      if (isHolidayKey(todayKey)) {
        return { key: todayKey, name: HOLIDAYS.get(todayKey), today: true, days: 0 };
      }
      for (let i = 1; i <= 400; i += 1) {
        const key = dayKey(beijingParts(beijingInstant(p.y, p.mo, p.day + i, 12, 0)));
        if (isHolidayKey(key)) {
          return { key: key, name: HOLIDAYS.get(key), today: false, days: i };
        }
      }
      return null;
    }

    /* ==================================================================
     * 4. 计价
     * ================================================================== */
    function resolveModel(selection) {
      const chosen = selection && (selection.next || selection.lastUsed);
      if (chosen && typeof chosen.model === 'string' && chosen.model !== '') {
        const provider = typeof chosen.provider === 'string' ? chosen.provider : '';
        const id = Object.prototype.hasOwnProperty.call(MODEL_ALIASES, chosen.model)
          ? MODEL_ALIASES[chosen.model]
          : chosen.model;
        return {
          id: id,
          raw: chosen.model,
          provider: provider,
          isDeepSeek: provider.indexOf('deepseek') !== -1,
          known: Object.prototype.hasOwnProperty.call(PRICE_TABLE, id),
        };
      }
      return { id: DEFAULT_MODEL, raw: DEFAULT_MODEL, provider: '', isDeepSeek: true, known: true, assumed: true };
    }

    function priceBand(modelId, peak) {
      const entry = Object.prototype.hasOwnProperty.call(PRICE_TABLE, modelId)
        ? PRICE_TABLE[modelId]
        : PRICE_TABLE[DEFAULT_MODEL];
      const band = peak ? 'peak' : 'offPeak';
      return {
        label: entry.label,
        cacheHit: entry.cacheHit[band],
        cacheMiss: entry.cacheMiss[band],
        output: entry.output[band],
        peak: peak,
      };
    }

    function zeroBuckets() {
      return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    }

    function numberOr0(value) {
      return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
    }

    /** 缓存未命中输入 = 未缓存输入 + 缓存写入（DeepSeek 按未命中价计费）。 */
    function bucketCost(buckets, price) {
      const missInput = buckets.uncachedInputTokens + buckets.cacheWriteTokens;
      return (
        (buckets.cacheReadTokens / 1e6) * price.cacheHit +
        (missInput / 1e6) * price.cacheMiss +
        (buckets.outputTokens / 1e6) * price.output
      );
    }

    function addBuckets(target, usage) {
      target.uncachedInputTokens += numberOr0(usage.inputTokens);
      target.cacheReadTokens += numberOr0(usage.cacheReadTokens);
      target.cacheWriteTokens += numberOr0(usage.cacheWriteTokens);
      target.outputTokens += numberOr0(usage.outputTokens);
    }

    function bucketsTotal(b) {
      return b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens;
    }

    /**
     * 按「模型步完成的时刻」把用量拆到高峰 / 空闲两段，这样跨越时段边界的长会话
     * 也能按当时生效的单价计价。窗口被分页时节点不完整，调用方会用投影总量兜底。
     */
    function splitByBand(nodes) {
      if (!Array.isArray(nodes)) return null;
      const peak = zeroBuckets();
      const offPeak = zeroBuckets();
      let seen = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node || node.kind !== 'assistant' || !node.usage) continue;
        const timing = node.timing;
        const at = timing && typeof timing.completedTime === 'number' ? timing.completedTime : null;
        if (at === null) continue;
        addBuckets(isPeakInstant(at) ? peak : offPeak, node.usage);
        seen += 1;
      }
      if (seen === 0) return null;
      return { peak: peak, offPeak: offPeak, steps: seen };
    }

    /* ==================================================================
     * 5. 格式化
     * ================================================================== */
    function money(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '--';
      if (value === 0) return '¥0.0000';
      if (value < 0.01) return '¥' + value.toFixed(6);
      if (value < 1) return '¥' + value.toFixed(4);
      return '¥' + value.toFixed(2);
    }

    function unitPrice(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '--';
      return '¥' + String(value);
    }

    function tokens(count) {
      if (typeof count !== 'number' || !isFinite(count)) return '0';
      if (count < 1000) return String(Math.round(count));
      if (count < 1e6) return (count / 1000).toFixed(count < 1e4 ? 2 : 1) + 'K';
      return (count / 1e6).toFixed(2) + 'M';
    }

    function duration(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      if (hh > 0) return hh + ' 小时 ' + mm + ' 分';
      if (mm > 0) return mm + ' 分 ' + ss + ' 秒';
      return ss + ' 秒';
    }

    function clockOf(ms) {
      const p = beijingParts(ms);
      return pad2(p.mo) + '-' + pad2(p.day) + ' ' + pad2(p.hh) + ':' + pad2(p.mi);
    }

    function countdownOf(ms, nowMs) {
      if (ms === null) return '--';
      return duration(ms - nowMs);
    }

    /* ==================================================================
     * 6. 样式（只用宿主主题 token）
     * ================================================================== */
    const CSS = [
      '.dsp_root{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px) - 4 * var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - 4 * var(--dsh-composer-dock-inset,8px));margin:0 auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsp_bar{isolation:isolate;box-sizing:border-box;position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:28px;padding:2px 12px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-panel)}',
      '.dsp_bar:before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}',
      '.dsp_bar:hover{color:var(--dsw-alias-label-primary)}',
      '.dsp_chip{display:inline-flex;align-items:center;gap:5px;flex:none;padding:1px 8px;border-radius:999px;font-weight:500;background:var(--dsw-alias-bg-layer-2)}',
      '.dsp_chipPeak{color:var(--dsw-alias-state-warn-primary)}',
      '.dsp_chipOff{color:var(--dsw-alias-state-success-primary)}',
      '.dsp_dot{width:6px;height:6px;border-radius:999px;background:currentColor;flex:none}',
      '.dsp_model{flex:none;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsp_prices{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsp_grow{flex:1 1 auto;min-width:0}',
      '.dsp_cost{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
      '.dsp_countdown{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsp_details{margin-top:6px;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsp_grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 14px;margin:0}',
      '.dsp_grid dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsp_grid dd{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}',
      '.dsp_row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 14px;margin:6px 0 0;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsp_rowTitle{grid-column:1 / -1;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dsp_note{grid-column:1 / -1;margin:4px 0 0;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.dsp_err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    /* ==================================================================
     * 7. 界面文案
     * ================================================================== */
    const ZH = {
      'band.peak': '高峰时段',
      'band.off': '空闲时段',
      'reason.weekend': '周末全天',
      'reason.holiday': '法定节假日全天',
      'reason.weekday-before': '工作日 09:00 前',
      'reason.weekday-am': '工作日 09:00-12:00',
      'reason.weekday-lunch': '工作日午休 12:00-14:00',
      'reason.weekday-pm': '工作日 14:00-18:00',
      'reason.weekday-night': '工作日 18:00 后',
      'label.toPeak': '距高峰',
      'label.toOff': '距空闲',
      'label.beijing': '北京时间',
      'label.reason': '时段原因',
      'label.nextPeak': '下一个高峰',
      'label.nextOff': '下一个空闲',
      'label.holiday': '法定节假日',
      'label.model': '当前模型',
      'label.unitPrice': '实时单价',
      'label.usage': '会话 tokens',
      'label.cost': '会话花费',
      'label.split': '分时段计价',
      'label.nextHoliday': '下一个节假日',
      'label.source': '价目来源',
      'holiday.today': '今天是',
      'holiday.none': '今天不是节假日，距 ',
      'holiday.unknown': '今天不是节假日（价目表未覆盖之后的节假日）',
      'holiday.after': ' 还有 ',
      'holiday.days': ' 天',
      'price.hit': '缓存命中输入',
      'price.miss': '缓存未命中输入',
      'price.out': '输出',
      'perMillion': ' / 百万 tokens',
      'usage.read': '缓存读',
      'usage.miss': '未命中输入',
      'usage.write': '缓存写入',
      'usage.out': '输出',
      'split.exact': '按各步完成时刻分段计价',
      'split.estimate': '窗口内节点不完整，按当前时段单价整体估算',
      'split.none': '暂无用量记录',
      'note.billing': '计费口径：缓存未命中输入 = 未缓存输入 + 缓存写入；空闲价 = 高峰价 × 50%。',
      'note.free': '未检测到 DeepSeek 路由，暂不计价。',
      'note.unknownModel': '该模型未收录价目，以下按 ' + DEFAULT_MODEL + ' 计。',
      'assumed': '（默认模型，会话尚未发起请求）',
      'checked': '价格核对时间 ' + PRICE_CHECKED_AT,
      'misc.title': 'DeepSeek 实时价格',
    };
    const EN = {
      'band.peak': 'Peak',
      'band.off': 'Off-peak',
      'reason.weekend': 'whole weekend',
      'reason.holiday': 'public holiday, all day',
      'reason.weekday-before': 'weekday before 09:00',
      'reason.weekday-am': 'weekday 09:00-12:00',
      'reason.weekday-lunch': 'weekday lunch 12:00-14:00',
      'reason.weekday-pm': 'weekday 14:00-18:00',
      'reason.weekday-night': 'weekday after 18:00',
      'label.toPeak': 'Peak in',
      'label.toOff': 'Off-peak in',
      'label.beijing': 'Beijing time',
      'label.reason': 'Why',
      'label.nextPeak': 'Next peak',
      'label.nextOff': 'Next off-peak',
      'label.holiday': 'Holiday',
      'label.model': 'Model',
      'label.unitPrice': 'Live unit price',
      'label.usage': 'Session tokens',
      'label.cost': 'Session cost',
      'label.split': 'Band split',
      'label.nextHoliday': 'Next holiday',
      'label.source': 'Price source',
      'holiday.today': 'Today is ',
      'holiday.none': 'Not a holiday; ',
      'holiday.unknown': 'Not a holiday (no later holiday in the price table yet)',
      'holiday.after': ' in ',
      'holiday.days': ' days',
      'price.hit': 'cache-hit input',
      'price.miss': 'cache-miss input',
      'price.out': 'output',
      'perMillion': ' / 1M tokens',
      'usage.read': 'cache read',
      'usage.miss': 'uncached input',
      'usage.write': 'cache write',
      'usage.out': 'output',
      'split.exact': 'priced per step completion time',
      'split.estimate': 'window incomplete; estimated at the current band rate',
      'split.none': 'no usage recorded yet',
      'note.billing': 'Billing: cache-miss input = uncached input + cache write; off-peak = 50% of peak.',
      'note.free': 'No DeepSeek route detected; cost is not estimated.',
      'note.unknownModel': 'Unknown model; priced as ' + DEFAULT_MODEL + '.',
      'assumed': ' (default model, no request yet)',
      'checked': 'Prices checked ' + PRICE_CHECKED_AT,
      'misc.title': 'DeepSeek live pricing',
    };

    /* ==================================================================
     * 8. 组件
     * ================================================================== */
    function PricingBar(props) {
      const useProjection = props.useProjection;
      const useChat = props.useChat;
      const t = props.t;
      const [now, setNow] = React.useState(function () {
        return Date.now();
      });
      const [open, setOpen] = React.useState(false);

      React.useEffect(function () {
        const id = setInterval(function () {
          setNow(Date.now());
        }, 1000);
        return function () {
          clearInterval(id);
        };
      }, []);

      const usage = useProjection ? useProjection('tokenUsage') : undefined;
      const selection = useProjection ? useProjection('modelSelection') : undefined;
      const nodes = useChat
        ? useChat(function (state) {
            return state && state.legacy ? state.legacy.nodes : undefined;
          })
        : undefined;

      const model = React.useMemo(function () {
        return resolveModel(selection);
      }, [selection]);

      const split = React.useMemo(function () {
        return splitByBand(nodes);
      }, [nodes]);

      let tr = function (key) {
        return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
      };
      if (typeof t === 'function') {
        const bound = t;
        tr = function (key) {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch (error) {
            /* fall through to the built-in dictionary */
          }
          return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
        };
      }

      const phase = phaseOf(now);
      const price = priceBand(model.id, phase.peak);
      const change = nextBandChange(now);
      const nextPeak = nextBandStart(now, true);
      const nextOff = nextBandStart(now, false);
      const holiday = nextHoliday(now);

      const totals = usage
        ? {
            uncachedInputTokens: numberOr0(usage.uncachedInputTokens),
            cacheReadTokens: numberOr0(usage.cacheReadTokens),
            cacheWriteTokens: numberOr0(usage.cacheWriteTokens),
            outputTokens: numberOr0(usage.outputTokens),
          }
        : zeroBuckets();

      // 分时段精确计价：窗口节点合计与整段会话投影一致时采用，否则按当前时段估算。
      let cost = bucketCost(totals, price);
      let costMode = 'estimate';
      if (split !== null) {
        const splitTotal = bucketsTotal(split.peak) + bucketsTotal(split.offPeak);
        const projectionTotal = bucketsTotal(totals);
        if (projectionTotal > 0 && Math.abs(splitTotal - projectionTotal) <= Math.max(1, projectionTotal * 0.001)) {
          cost =
            bucketCost(split.peak, priceBand(model.id, true)) +
            bucketCost(split.offPeak, priceBand(model.id, false));
          costMode = 'exact';
        }
      }
      if (!model.isDeepSeek) cost = 0;

      const countdownText =
        change === null
          ? ''
          : (change.becomesPeak ? tr('label.toPeak') : tr('label.toOff')) + ' ' + duration(change.at - now);

      const chipText = phase.peak ? tr('band.peak') : tr('band.off');
      const reasonText = phase.holidayName
        ? phase.holidayName + ' · ' + tr('reason.holiday')
        : tr('reason.' + phase.reason);

      const bar = h(
        'button',
        {
          type: 'button',
          className: 'dsp_bar',
          'aria-expanded': open,
          title: tr('misc.title'),
          onClick: function () {
            setOpen(function (value) {
              return !value;
            });
          },
        },
        h(
          'span',
          { className: 'dsp_chip ' + (phase.peak ? 'dsp_chipPeak' : 'dsp_chipOff') },
          h('span', { className: 'dsp_dot', 'aria-hidden': true }),
          chipText,
        ),
        h('span', { className: 'dsp_model' }, model.id),
        h(
          'span',
          { className: 'dsp_prices' },
          model.isDeepSeek
            ? tr('price.hit') +
                ' ' +
                unitPrice(price.cacheHit) +
                ' · ' +
                tr('price.miss') +
                ' ' +
                unitPrice(price.cacheMiss) +
                ' · ' +
                tr('price.out') +
                ' ' +
                unitPrice(price.output) +
                tr('perMillion')
            : tr('note.free'),
        ),
        h('span', { className: 'dsp_grow' }),
        h('span', { className: 'dsp_cost' }, tr('label.cost') + ' ' + money(cost)),
        countdownText === '' ? null : h('span', { className: 'dsp_countdown' }, countdownText),
      );

      if (!open) return h('div', { className: 'dsp_root' }, bar);

      const detailRows = [
        [tr('label.beijing'), phase.dateText + ' ' + phase.clock],
        [tr('label.reason'), reasonText + ' → ' + chipText],
        [
          change === null ? tr('label.toOff') : change.becomesPeak ? tr('label.toPeak') : tr('label.toOff'),
          countdownOf(change === null ? null : change.at, now),
        ],
        [tr('label.nextPeak'), nextPeak === null ? '--' : clockOf(nextPeak)],
        [tr('label.nextOff'), nextOff === null ? '--' : clockOf(nextOff)],
        [
          tr('label.holiday'),
          phase.holidayName !== null
            ? tr('holiday.today') + phase.holidayName
            : holiday === null
              ? tr('holiday.unknown')
              : tr('holiday.none') + holiday.name + tr('holiday.after') + holiday.days + tr('holiday.days'),
        ],
        [tr('label.model'), model.id + '（' + price.label + '）' + (model.assumed ? tr('assumed') : '')],
      ];

      const usageRows = [
        [tr('usage.read'), tokens(totals.cacheReadTokens) + ' · ' + unitPrice(price.cacheHit) + tr('perMillion')],
        [
          tr('usage.miss'),
          tokens(totals.uncachedInputTokens + totals.cacheWriteTokens) + ' · ' + unitPrice(price.cacheMiss) + tr('perMillion'),
        ],
        [tr('usage.write'), tokens(totals.cacheWriteTokens)],
        [tr('usage.out'), tokens(totals.outputTokens) + ' · ' + unitPrice(price.output) + tr('perMillion')],
      ];

      const splitRows = [];
      let splitNote = tr('split.estimate');
      if (costMode === 'exact' && split !== null) {
        splitRows.push([
          tr('band.peak'),
          tokens(bucketsTotal(split.peak)) + ' tokens · ' + money(bucketCost(split.peak, priceBand(model.id, true))),
        ]);
        splitRows.push([
          tr('band.off'),
          tokens(bucketsTotal(split.offPeak)) + ' tokens · ' + money(bucketCost(split.offPeak, priceBand(model.id, false))),
        ]);
      } else if (split === null) {
        splitNote = tr('split.none');
      }

      const details = h(
        'div',
        { className: 'dsp_details' },
        h(
          'dl',
          { className: 'dsp_grid' },
          detailRows.map(function (row, index) {
            return [h('dt', { key: 'k' + index }, row[0]), h('dd', { key: 'v' + index }, row[1])];
          }),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('label.unitPrice')),
          usageRows.map(function (row, index) {
            return [h('dt', { key: 'k' + index }, row[0]), h('dd', { key: 'v' + index }, row[1])];
          }),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('label.split') + ' · ' + (costMode === 'exact' ? tr('split.exact') : splitNote)),
          splitRows.length === 0
            ? h('div', { className: 'dsp_note' }, splitNote)
            : splitRows.map(function (row, index) {
                return [h('dt', { key: 'k' + index }, row[0]), h('dd', { key: 'v' + index }, row[1])];
              }),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('label.source')),
          h('dt', { className: 'dsp_note' }, PRICE_SOURCE + ' · ' + tr('checked')),
          h('dt', { className: 'dsp_note' }, tr('note.billing')),
          model.isDeepSeek ? null : h('dt', { className: 'dsp_note dsp_err' }, tr('note.free')),
          model.known ? null : h('dt', { className: 'dsp_note' }, tr('note.unknownModel')),
        ),
      );

      return h('div', { className: 'dsp_root' }, bar, details);
    }

    /** 组件崩溃时保留一条可读提示，而不是把整个席位置空。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[deepseek-pricing] render failed', error);
        }
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'dsp_root' },
            h(
              'div',
              { className: 'dsp_details dsp_err' },
              'DeepSeek 实时价格渲染失败：' + String((this.state.error && this.state.error.message) || this.state.error),
            ),
          );
        }
        return this.props.children;
      }
    }

    function PricingDock(props) {
      return h(Boundary, null, h(PricingBar, props));
    }

    /* ==================================================================
     * 9. 插件入口
     * ================================================================== */
    function apply(ctx) {
      // 1) 席位注册放在最前：样式或词典这一步出问题也不该让价格条消失。
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'deepseek-pricing',
            order: 5,
            locale: NS,
          },
          PricingDock,
        );
      });

      // 2) 样式表（随插件卸载移除）。
      try {
        ctx.effect(function () {
          const tag = document.createElement('style');
          tag.setAttribute('data-plugin-css', 'dsh-live-pricing');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        }, 'deepseek-pricing: styles');
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[deepseek-pricing] style registration failed', error);
      }

      // 3) 界面文案词典；缺失时组件内部回退到内置中文。
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: ZH, en: EN });
          }, 'deepseek-pricing: dictionaries');
        }
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[deepseek-pricing] dictionary registration failed', error);
      }
    }

    return {
      inject: ['slots'],
      apply: apply,
    };
  },
});

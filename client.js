/**
 * DeepSeek 峰谷时段 / 节假日 / 实时单价条 —— Client half。
 *
 * 渲染到会话输入框下方的 `conversation.composer.dock` 席位（与官方统计条并列），
 * 每秒刷新一次时钟与倒计时。
 *
 * 它回答三件事：
 *   1. 现在（北京时间）是高峰时段还是空闲时段，下一次切换还有多久；
 *   2. 今天是不是中国法定节假日，距下一个节假日还有多久；
 *   3. 当前模型此刻生效的实时单价（缓存命中输入 / 缓存未命中输入 / 输出）。
 *
 * **本插件不计算、不显示任何消费金额。** 金额口径涉及币种、汇率、峰谷加权与平台
 * 账单细节，极易与实际账单对不上；这里只显示不依赖用量的"费率"，以及不依赖网络
 * 与账号的"时段"。想知道一共花了多少钱，请用官方用量页或专门的计费插件。
 *
 * 价目来源：
 *   官方机器可读表 —— DSH 内置的 @earendil-works/pi-ai/dist/providers/data/deepseek.json（USD / 百万 token）
 *   官方文档价目 —— https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（人民币 / 百万 token）
 * 规则：高峰时段 = 北京时间 周一至周五（不含中国法定节假日）
 *       09:00-12:00 与 14:00-18:00；其余时段（含周末与法定节假日全天）
 *       为空闲时段，空闲价 = 高峰价 × 50%。
 *
 * 当前模型来自内置的 `modelSelection` 会话投影。
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-pricing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'deepseek-pricing';

    /* ==================================================================
     * 1. 价目表（高峰价；空闲价 = 高峰价 × 50%）
     *    usd 取自 DSH 内置的 pi-ai 官方 provider 数据；
     *    cny 取自官方中文价目页。
     * ================================================================== */
    const PRICE_TABLE = {
      'deepseek-flash': {
        label: 'DeepSeek-V4.1-Flash',
        usd: { hit: 0.006, miss: 0.3, out: 1.2 },
        cny: { hit: 0.04, miss: 2, out: 8 },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek-V4-Pro',
        usd: { hit: 0.044, miss: 1.32, out: 3.96 },
        cny: { hit: 0.3, miss: 9, out: 27 },
      },
    };
    /** 官方文档点名的旧模型名，仍按 Flash 计费。 */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };
    const DEFAULT_MODEL = 'deepseek-flash';
    const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
    const PRICE_CHECKED_AT = '2026-10-01';

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

    /** 下一次「高峰 / 空闲」状态翻转的时刻。 */
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

    /** 当前时段画像：高峰与否、节假日、周末、以及「为什么」。 */
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
        clock: pad2(p.hh) + ':' + pad2(p.mi) + ':' + pad2(p.sec),
        dateText: key + ' 周' + '日一二三四五六'.charAt(p.wd),
      };
    }

    /** 今天全天的时段划分，用于「今日时段」。 */
    function todaySchedule(ms) {
      const p = beijingParts(ms);
      const key = dayKey(p);
      const holidayName = HOLIDAYS.get(key) || null;
      if (holidayName !== null) return { allOff: true, reason: holidayName };
      if (p.wd === 0 || p.wd === 6) return { allOff: true, reason: 'weekend' };
      return {
        allOff: false,
        peakText: '09:00-12:00、14:00-18:00',
        offText: '00:00-09:00、12:00-14:00、18:00-24:00',
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
     * 4. 模型与单价
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
          provider: provider,
          isDeepSeek: provider.indexOf('deepseek') !== -1,
          known: Object.prototype.hasOwnProperty.call(PRICE_TABLE, id),
          assumed: false,
        };
      }
      return { id: DEFAULT_MODEL, provider: '', isDeepSeek: true, known: true, assumed: true };
    }

    function halve(price) {
      return { hit: price.hit / 2, miss: price.miss / 2, out: price.out / 2 };
    }

    function priceOf(modelId, peak) {
      const entry = Object.prototype.hasOwnProperty.call(PRICE_TABLE, modelId)
        ? PRICE_TABLE[modelId]
        : PRICE_TABLE[DEFAULT_MODEL];
      return {
        label: entry.label,
        cny: peak ? entry.cny : halve(entry.cny),
        usd: peak ? entry.usd : halve(entry.usd),
        peak: peak,
      };
    }

    /* ==================================================================
     * 5. 格式化
     * ================================================================== */
    function priceText(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '--';
      return String(value);
    }

    function duration(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const dd = Math.floor(total / 86400);
      const hh = Math.floor((total % 86400) / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      // 长假期间"距高峰"会跨越好几天，所以先报天，避免出现"169 小时"这种读不出来的数。
      if (dd > 0) return dd + ' 天 ' + hh + ' 小时';
      if (hh > 0) return hh + ' 小时 ' + mm + ' 分';
      if (mm > 0) return mm + ' 分 ' + ss + ' 秒';
      return ss + ' 秒';
    }

    function clockOf(ms) {
      const p = beijingParts(ms);
      return pad2(p.mo) + '-' + pad2(p.day) + ' ' + pad2(p.hh) + ':' + pad2(p.mi);
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
      '.dsp_countdown{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
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
      'label.today': '今日时段',
      'label.holiday': '法定节假日',
      'label.nextHoliday': '下一个节假日',
      'label.model': '当前模型',
      'label.unitPrice': '实时单价（当前时段）',
      'label.bothBands': '高峰 / 空闲 两档对照',
      'label.source': '价目来源',
      'holiday.today': '今天是',
      'holiday.none': '今天不是节假日，距 ',
      'holiday.unknown': '今天不是节假日（价目表未覆盖之后的节假日）',
      'holiday.after': ' 还有 ',
      'holiday.days': ' 天',
      'today.allOff': '全天空闲 —— ',
      'today.peakIs': '高峰 ',
      'today.offIs': '；空闲 ',
      'price.hit': '缓存命中输入',
      'price.miss': '缓存未命中输入',
      'price.out': '输出',
      'perMillion': ' 元 / 百万 tokens',
      'order': '顺序：缓存命中 / 缓存未命中 / 输出',
      'usdPrefix': '官方英文价目（当前时段）：',
      'usdSuffix': ' 美元 / 百万 tokens',
      'split.half': '空闲价为高峰价的 50%',
      'checked': '价格核对时间 ' + PRICE_CHECKED_AT,
      'noCostTitle': '本插件不计算消费金额',
      'noCostBody': '金额口径涉及币种、汇率、峰谷加权与平台账单细节，容易与官方账单对不上。想知道一共花了多少钱，请用官方用量页或专门的计费插件。',
      'note.free': '未检测到 DeepSeek 路由，以下单价仅供参考。',
      'note.unknownModel': '该模型未收录价目，以下按 ' + DEFAULT_MODEL + ' 计。',
      'assumed': '（默认模型，会话尚未发起请求）',
      'misc.title': 'DeepSeek 峰谷时段与实时单价',
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
      'label.today': 'Today',
      'label.holiday': 'Holiday',
      'label.nextHoliday': 'Next holiday',
      'label.model': 'Model',
      'label.unitPrice': 'Live unit price (current band)',
      'label.bothBands': 'Peak / off-peak',
      'label.source': 'Price source',
      'holiday.today': 'Today is ',
      'holiday.none': 'Not a holiday; ',
      'holiday.unknown': 'Not a holiday (no later holiday in the price table yet)',
      'holiday.after': ' in ',
      'holiday.days': ' days',
      'today.allOff': 'Off-peak all day — ',
      'today.peakIs': 'Peak ',
      'today.offIs': '; off-peak ',
      'price.hit': 'cache-hit input',
      'price.miss': 'cache-miss input',
      'price.out': 'output',
      'perMillion': ' CNY / 1M tokens',
      'order': 'order: cache hit / cache miss / output',
      'usdPrefix': 'Official USD list (current band): ',
      'usdSuffix': ' USD / 1M tokens',
      'split.half': 'off-peak is 50% of peak',
      'checked': 'checked ' + PRICE_CHECKED_AT,
      'noCostTitle': 'No spend is computed',
      'noCostBody': 'Money figures depend on currency, FX rate, band weighting and billing details, so they easily disagree with the official bill. Use the official usage page or a dedicated billing plugin for spend.',
      'note.free': 'No DeepSeek route detected; prices are for reference only.',
      'note.unknownModel': 'Unknown model; priced as ' + DEFAULT_MODEL + '.',
      'assumed': ' (default model, no request yet)',
      'misc.title': 'DeepSeek peak / off-peak and live unit price',
    };

    /* ==================================================================
     * 8. 组件
     * ================================================================== */
    function BandBar(props) {
      const useProjection = props.useProjection;
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

      const selection = useProjection ? useProjection('modelSelection') : undefined;

      const model = React.useMemo(function () {
        return resolveModel(selection);
      }, [selection]);

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
      const peakPrice = priceOf(model.id, true);
      const offPrice = priceOf(model.id, false);
      const price = phase.peak ? peakPrice : offPrice;
      const change = nextBandChange(now);
      const nextPeak = nextBandStart(now, true);
      const nextOff = nextBandStart(now, false);
      const holiday = nextHoliday(now);
      const schedule = todaySchedule(now);

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
                ' ¥' +
                priceText(price.cny.hit) +
                ' · ' +
                tr('price.miss') +
                ' ¥' +
                priceText(price.cny.miss) +
                ' · ' +
                tr('price.out') +
                ' ¥' +
                priceText(price.cny.out) +
                tr('perMillion')
            : tr('note.free'),
        ),
        h('span', { className: 'dsp_grow' }),
        countdownText === '' ? null : h('span', { className: 'dsp_countdown' }, countdownText),
      );

      if (!open) return h('div', { className: 'dsp_root' }, bar);

      const todayText = schedule.allOff
        ? tr('today.allOff') + (schedule.reason === 'weekend' ? tr('reason.weekend') : schedule.reason)
        : tr('today.peakIs') + schedule.peakText + tr('today.offIs') + schedule.offText;

      const holidayText =
        phase.holidayName !== null
          ? tr('holiday.today') + phase.holidayName
          : holiday === null
            ? tr('holiday.unknown')
            : holiday.name + tr('holiday.after') + holiday.days + tr('holiday.days');

      const detailRows = [
        [tr('label.beijing'), phase.dateText + ' ' + phase.clock],
        [tr('label.reason'), reasonText + ' → ' + chipText],
        [
          change === null ? tr('label.toOff') : change.becomesPeak ? tr('label.toPeak') : tr('label.toOff'),
          change === null ? '--' : duration(change.at - now),
        ],
        [tr('label.nextPeak'), nextPeak === null ? '--' : clockOf(nextPeak)],
        [tr('label.nextOff'), nextOff === null ? '--' : clockOf(nextOff)],
        [tr('label.today'), todayText],
        [tr('label.holiday'), holidayText],
        [tr('label.nextHoliday'), holiday === null ? '--' : holiday.key + ' ' + holiday.name],
        [tr('label.model'), model.id + '（' + price.label + '）' + (model.assumed ? tr('assumed') : '')],
      ];

      const triple = function (band) {
        return '¥' + priceText(band.cny.hit) + ' / ¥' + priceText(band.cny.miss) + ' / ¥' + priceText(band.cny.out);
      };

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
          h('div', { className: 'dsp_rowTitle' }, tr('label.unitPrice') + ' · ' + chipText),
          h('dt', null, tr('price.hit')),
          h('dd', null, '¥' + priceText(price.cny.hit) + tr('perMillion')),
          h('dt', null, tr('price.miss')),
          h('dd', null, '¥' + priceText(price.cny.miss) + tr('perMillion')),
          h('dt', null, tr('price.out')),
          h('dd', null, '¥' + priceText(price.cny.out) + tr('perMillion')),
          h('dt', { className: 'dsp_note' }, tr('split.half')),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('label.bothBands')),
          h('dt', null, tr('band.peak')),
          h('dd', null, triple(peakPrice)),
          h('dt', null, tr('band.off')),
          h('dd', null, triple(offPrice)),
          h('dt', { className: 'dsp_note' }, tr('order')),
          h(
            'dt',
            { className: 'dsp_note' },
            tr('usdPrefix') +
              '$' +
              priceText(price.usd.hit) +
              ' · $' +
              priceText(price.usd.miss) +
              ' · $' +
              priceText(price.usd.out) +
              tr('usdSuffix'),
          ),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('label.source')),
          h('dt', { className: 'dsp_note' }, PRICE_SOURCE + ' · ' + tr('checked')),
          model.isDeepSeek ? null : h('dt', { className: 'dsp_note dsp_err' }, tr('note.free')),
          model.known ? null : h('dt', { className: 'dsp_note' }, tr('note.unknownModel')),
        ),
        h(
          'dl',
          { className: 'dsp_row' },
          h('div', { className: 'dsp_rowTitle' }, tr('noCostTitle')),
          h('dt', { className: 'dsp_note' }, tr('noCostBody')),
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
              'DeepSeek 时段条渲染失败：' + String((this.state.error && this.state.error.message) || this.state.error),
            ),
          );
        }
        return this.props.children;
      }
    }

    function BandDock(props) {
      return h(Boundary, null, h(BandBar, props));
    }

    /* ==================================================================
     * 9. 插件入口
     * ================================================================== */
    function apply(ctx) {
      // 席位注册放在最前：样式或词典出问题也不该让时段条消失。
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'deepseek-pricing',
            order: 5,
            locale: NS,
          },
          BandDock,
        );
      });

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

/**
 * DeepSeek 峰谷时段条 —— Client half。
 *
 * 渲染到会话输入框下方的 `conversation.composer.dock` 席位（与官方统计条并列）。
 *
 * 条形只有三格：现在是不是空闲时段、用的是哪个模型、本会话花了多少钱。
 * 点开后只加一件事：此刻生效的实时单价。
 *
 * 金额的分桶（高峰 / 空闲）由 Host 端投影 `deepseekLivePricing` 提供：它逐条按
 * assistant/message 的发生时刻归档，折叠整段日志，因此不受客户端窗口分页影响；
 * 本文件只负责按对应时段的单价乘出结果。
 *
 * 价目来源：
 *   官方机器可读表 —— DSH 内置的 @earendil-works/pi-ai/dist/providers/data/deepseek.json（USD / 百万 token）
 *   官方文档价目 —— https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（人民币 / 百万 token，本插件按此展示）
 * 规则：高峰时段 = 北京时间 周一至周五（不含中国法定节假日）
 *       09:00-12:00 与 14:00-18:00；其余时段（含周末与法定节假日全天）
 *       为空闲时段，空闲价 = 高峰价 × 50%。
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-pricing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'deepseek-pricing';

    /* ==================================================================
     * 1. 价目表（人民币 / 百万 token，高峰价；空闲价 = 高峰价 × 50%）
     * ================================================================== */
    const PRICE_TABLE = {
      'deepseek-flash': {
        label: 'DeepSeek-V4.1-Flash',
        cny: { hit: 0.04, miss: 2, out: 8 },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek-V4-Pro',
        cny: { hit: 0.3, miss: 9, out: 27 },
      },
    };
    /** 官方文档点名的旧模型名，仍按 Flash 计费。 */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };
    const DEFAULT_MODEL = 'deepseek-flash';

    /* ==================================================================
     * 2. 中国法定节假日（2026，国办发明电〔2025〕7 号）
     *    只用于峰谷判定：法定节假日全天算空闲。
     * ================================================================== */
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
      for (let i = 0; i < HOLIDAY_RANGES.length; i += 1) {
        const start = Date.parse(HOLIDAY_RANGES[i][0] + 'T00:00:00Z');
        const end = Date.parse(HOLIDAY_RANGES[i][1] + 'T00:00:00Z');
        for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
      }
      return set;
    })();

    /* ==================================================================
     * 3. 北京时间与高峰时段判定
     *    北京时间为固定 UTC+8，无夏令时，所以直接位移后读 UTC 字段。
     * ================================================================== */
    const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
    const PEAK_WINDOWS = [[540, 720], [840, 1080]]; // 分钟数：09:00-12:00 / 14:00-18:00

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
        wd: d.getUTCDay(), // 0 = 周日
      };
    }

    function isPeakInstant(ms) {
      const p = beijingParts(ms);
      if (p.wd === 0 || p.wd === 6) return false;
      const key = String(p.y) + '-' + pad2(p.mo) + '-' + pad2(p.day);
      if (HOLIDAYS.has(key)) return false;
      const minutes = p.hh * 60 + p.mi;
      for (let i = 0; i < PEAK_WINDOWS.length; i += 1) {
        if (minutes >= PEAK_WINDOWS[i][0] && minutes < PEAK_WINDOWS[i][1]) return true;
      }
      return false;
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
          isDeepSeek: provider.indexOf('deepseek') !== -1,
          known: Object.prototype.hasOwnProperty.call(PRICE_TABLE, id),
        };
      }
      return { id: DEFAULT_MODEL, isDeepSeek: true, known: true, assumed: true };
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
      };
    }

    function priceText(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '--';
      return String(value);
    }

    /* ==================================================================
     * 5. 会话金额
     *     分桶数据由 Host 端投影 `deepseekLivePricing` 提供。
     * ================================================================== */
    function numberOr0(value) {
      return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
    }

    function zeroBuckets() {
      return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }

    function asBuckets(value) {
      if (value === null || typeof value !== 'object') return zeroBuckets();
      return {
        uncachedInputTokens: numberOr0(value.uncachedInputTokens),
        outputTokens: numberOr0(value.outputTokens),
        cacheReadTokens: numberOr0(value.cacheReadTokens),
        cacheWriteTokens: numberOr0(value.cacheWriteTokens),
      };
    }

    /** 缓存未命中输入 = 未缓存输入 + 缓存写入（DeepSeek 按未命中价计费）。 */
    function bucketCost(buckets, price) {
      const missInput = buckets.uncachedInputTokens + buckets.cacheWriteTokens;
      return (
        (buckets.cacheReadTokens / 1e6) * price.cny.hit +
        (missInput / 1e6) * price.cny.miss +
        (buckets.outputTokens / 1e6) * price.cny.out
      );
    }

    function bucketsTotal(buckets) {
      return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
    }

    function money(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '--';
      if (value === 0) return '¥0.0000';
      if (value < 0.01) return '¥' + value.toFixed(6);
      if (value < 1) return '¥' + value.toFixed(4);
      return '¥' + value.toFixed(2);
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
      '.dsp_grow{flex:1 1 auto;min-width:0}',
      '.dsp_cost{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
      '.dsp_details{margin-top:6px;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsp_grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 14px;margin:0}',
      '.dsp_grid dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsp_grid dd{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsp_title{grid-column:1 / -1;margin:0 0 2px;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dsp_note{grid-column:1 / -1;margin:4px 0 0;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.dsp_err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    /* ==================================================================
     * 7. 界面文案
     * ================================================================== */
    const ZH = {
      'band.peak': '高峰时段',
      'band.off': '空闲时段',
      'label.sessionCost': '本会话',
      'label.unitPrice': '当前实时单价',
      'price.hit': '缓存命中输入',
      'price.miss': '缓存未命中输入',
      'price.out': '输出',
      'perMillion': ' 元 / 百万 tokens',
      'note.free': '未检测到 DeepSeek 路由，金额不可用。',
      'note.unknownModel': '该模型未收录价目，按 ' + DEFAULT_MODEL + ' 计。',
      'misc.title': 'DeepSeek 峰谷时段与实时单价',
    };
    const EN = {
      'band.peak': 'Peak',
      'band.off': 'Off-peak',
      'label.sessionCost': 'Session',
      'label.unitPrice': 'Current unit price',
      'price.hit': 'cache-hit input',
      'price.miss': 'cache-miss input',
      'price.out': 'output',
      'perMillion': ' CNY / 1M tokens',
      'note.free': 'No DeepSeek route detected; cost is unavailable.',
      'note.unknownModel': 'Unknown model; priced as ' + DEFAULT_MODEL + '.',
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
      // Host 端按事件时刻分好桶的用量；拿不到时退回 tokenUsage 整体估算。
      const split = useProjection ? useProjection('deepseekLivePricing') : undefined;
      const totals = useProjection ? useProjection('tokenUsage') : undefined;

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

      const peak = isPeakInstant(now);
      const peakPrice = priceOf(model.id, true);
      const offPrice = priceOf(model.id, false);
      const price = peak ? peakPrice : offPrice;

      // 金额：优先用 Host 端分时段投影（精确）；缺失时退回整体估算。
      let cost = null;
      if (model.isDeepSeek) {
        const sampled = split !== null && split !== undefined && typeof split.sampled === 'number' ? split.sampled : 0;
        if (split !== null && split !== undefined && sampled > 0) {
          cost = bucketCost(asBuckets(split.peak), peakPrice) + bucketCost(asBuckets(split.offPeak), offPrice);
        } else if (totals !== null && totals !== undefined) {
          const whole = asBuckets(totals);
          if (bucketsTotal(whole) > 0) cost = bucketCost(whole, price);
        }
      }
      const costText = cost === null ? '--' : money(cost);
      const chipText = peak ? tr('band.peak') : tr('band.off');

      let hint = tr('misc.title');
      if (!model.isDeepSeek) hint = tr('note.free');
      else if (!model.known) hint = tr('note.unknownModel');

      const bar = h(
        'button',
        {
          type: 'button',
          className: 'dsp_bar',
          'aria-expanded': open,
          title: hint,
          onClick: function () {
            setOpen(function (value) {
              return !value;
            });
          },
        },
        h(
          'span',
          { className: 'dsp_chip ' + (peak ? 'dsp_chipPeak' : 'dsp_chipOff') },
          h('span', { className: 'dsp_dot', 'aria-hidden': true }),
          chipText,
        ),
        h('span', { className: 'dsp_model' }, model.id),
        h('span', { className: 'dsp_grow' }),
        h('span', { className: 'dsp_cost' }, tr('label.sessionCost') + ' ' + costText),
      );

      if (!open) return h('div', { className: 'dsp_root' }, bar);

      const details = h(
        'div',
        { className: 'dsp_details' },
        h(
          'dl',
          { className: 'dsp_grid' },
          h('div', { className: 'dsp_title' }, tr('label.unitPrice') + ' · ' + chipText),
          h('dt', null, tr('price.hit')),
          h('dd', null, '¥' + priceText(price.cny.hit) + tr('perMillion')),
          h('dt', null, tr('price.miss')),
          h('dd', null, '¥' + priceText(price.cny.miss) + tr('perMillion')),
          h('dt', null, tr('price.out')),
          h('dd', null, '¥' + priceText(price.cny.out) + tr('perMillion')),
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

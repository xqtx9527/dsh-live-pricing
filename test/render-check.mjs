/**
 * 离线校验：用最小 React 运行时真机执行 client.js 的注册与渲染路径，
 * 断言峰谷时段判定、节假日判定、会话金额（分时段 / 估算兜底）与单价展示。
 *
 * 运行：node test/render-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

let failures = 0;
let checks = 0;

function assertEqual(label, actual, expected) {
  checks += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  => ' + JSON.stringify(actual) + (ok ? '' : '  (expected ' + JSON.stringify(expected) + ')'));
}

function assertMatch(label, haystack, needle) {
  checks += 1;
  const ok = typeof haystack === 'string' && haystack.indexOf(needle) !== -1;
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  => ' + JSON.stringify(haystack) + (ok ? '' : '  (missing ' + JSON.stringify(needle) + ')'));
}

function assertAbsent(label, haystack, needle) {
  checks += 1;
  const ok = typeof haystack === 'string' && haystack.indexOf(needle) === -1;
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  => ' + (ok ? '文本中不含 ' + JSON.stringify(needle) : '意外出现 ' + JSON.stringify(needle)));
}

/* ================= 最小 React 运行时 ================= */
const frames = {};
let ordinal = 0;

function createReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      const merged = Object.assign({}, props || {});
      merged.children = flat;
      return { type, props: merged, children: flat };
    },
    useState(initial) {
      const frame = frames[ordinal - 1];
      const index = frame.cursor;
      frame.cursor += 1;
      if (!(index in frame.hooks)) {
        frame.hooks[index] = typeof initial === 'function' ? initial() : initial;
      }
      const setter = (next) => {
        const value = typeof next === 'function' ? next(frame.hooks[index]) : next;
        if (value !== frame.hooks[index]) {
          frame.hooks[index] = value;
          frame.dirty = true;
        }
      };
      return [frame.hooks[index], setter];
    },
    useEffect(effect) {
      effect();
    },
    useMemo(factory) {
      return factory();
    },
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
  };
}

function enterFrame() {
  const key = ordinal;
  ordinal += 1;
  if (!frames[key]) frames[key] = { hooks: [], cursor: 0, dirty: false };
  frames[key].cursor = 0;
  return frames[key];
}

function expand(element) {
  if (element === null || element === undefined || element === false) return element;
  if (typeof element === 'string' || typeof element === 'number') return element;
  if (Array.isArray(element)) return element.map(expand);
  const type = element.type;
  if (typeof type === 'function') {
    const isClass = (type.prototype && typeof type.prototype.render === 'function')
      || Object.prototype.hasOwnProperty.call(type, 'getDerivedStateFromError');
    if (isClass) {
      const instance = new type(element.props);
      instance.props = element.props;
      if (instance.state === undefined) instance.state = {};
      return expand(instance.render());
    }
    enterFrame();
    return expand(type(element.props));
  }
  return { type: type, props: element.props, children: expand(element.children) };
}

function textsOf(element, out = []) {
  if (element === null || element === undefined || element === false) return out;
  if (typeof element === 'string' || typeof element === 'number') {
    out.push(String(element));
    return out;
  }
  if (Array.isArray(element)) {
    for (const child of element) textsOf(child, out);
    return out;
  }
  if (element.children) textsOf(element.children, out);
  return out;
}

function findAll(element, predicate, out = []) {
  if (element === null || element === undefined || typeof element !== 'object') return out;
  if (Array.isArray(element)) {
    for (const child of element) findAll(child, predicate, out);
    return out;
  }
  if (predicate(element)) out.push(element);
  findAll(element.children, predicate, out);
  return out;
}

/* ================= 加载插件 ================= */
function loadPlugin(nowMs) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() {
      return nowMs;
    }
  }

  const React = createReact();
  let registration = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          registration = definition;
        },
      },
    },
    document: {
      createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
      head: { appendChild() {} },
    },
    console,
    Date: FrozenDate,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Math,
    Number,
    Object,
    Array,
    String,
    JSON,
    Map,
    Set,
    Error,
    Symbol,
    isFinite,
    parseInt,
    parseFloat,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const module = registration.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });

  const registered = [];
  const injected = [];
  const effectReturns = [];
  const ctx = {
    effect: (fn) => {
      effectReturns.push(fn());
      return () => {};
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (key, callback) => {
        injected.push(key);
        return callback();
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);
  return { registered, injected, effectReturns };
}

/* ================= 渲染 ================= */
const DEFAULT_SELECTION = { next: { provider: 'deepseek-account', model: 'deepseek-flash' }, lastUsed: null };

/** 取自一次真实会话（210 步）的真实用量，用来验证金额与审计数字。 */
const REAL_PEAK = { uncachedInputTokens: 179130, outputTokens: 106151, cacheReadTokens: 19732608, cacheWriteTokens: 0 };
const REAL_OFF = { uncachedInputTokens: 70624, outputTokens: 72315, cacheReadTokens: 34377472, cacheWriteTokens: 0 };
const REAL_SPLIT = { peak: REAL_PEAK, offPeak: REAL_OFF, sampled: 210 };
const REAL_TOTALS = {
  uncachedInputTokens: REAL_PEAK.uncachedInputTokens + REAL_OFF.uncachedInputTokens,
  outputTokens: REAL_PEAK.outputTokens + REAL_OFF.outputTokens,
  cacheReadTokens: REAL_PEAK.cacheReadTokens + REAL_OFF.cacheReadTokens,
  cacheWriteTokens: 0,
};

function makeProps(options) {
  const selection = options.selection === undefined ? DEFAULT_SELECTION : options.selection;
  const split = options.split === undefined ? REAL_SPLIT : options.split;
  const totals = options.totals === undefined ? REAL_TOTALS : options.totals;
  return {
    useProjection: (key) => {
      if (key === 'modelSelection') return selection === null ? undefined : selection;
      if (key === 'deepseekLivePricing') return split === null ? undefined : split;
      if (key === 'tokenUsage') return totals === null ? undefined : totals;
      return undefined;
    },
    t: undefined,
    sessionId: 'session-test',
  };
}

function renderAt(nowMs, options = {}) {
  const loaded = loadPlugin(nowMs);
  const component = loaded.registered[0].component;
  const props = makeProps(options);

  for (const key of Object.keys(frames)) delete frames[key];

  let tree = null;
  const settle = () => {
    for (let pass = 0; pass < 30; pass += 1) {
      for (const key of Object.keys(frames)) frames[key].dirty = false;
      ordinal = 0;
      tree = expand(component(props));
      const dirty = Object.keys(frames).some((k) => frames[k].dirty);
      if (!dirty) break;
    }
  };
  settle();

  if (options.expand === true) {
    const buttons = findAll(tree, (el) => el.type === 'button' && typeof el.props.className === 'string' && el.props.className.indexOf('dsp_bar') !== -1);
    if (buttons.length === 0) throw new Error('expanded render: bar button not found');
    buttons[0].props.onClick();
    settle();
  }

  return { tree, text: textsOf(tree).join(' | '), ...loaded };
}

/* ================= 用例 ================= */
console.log('\n[1] 条形只显示 时段 + 模型 + 本会话金额');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text, registered, injected, effectReturns } = renderAt(at);
  assertEqual('注册席位', registered[0].options.name, 'conversation.composer.dock');
  assertEqual('注册 id', registered[0].options.id, 'deepseek-pricing');
  assertEqual('声明的注入服务', injected.join(','), 'conversation.composer.dock');
  assertMatch('时段', text, '高峰时段');
  assertMatch('模型', text, 'deepseek-flash');
  assertMatch('本会话金额 ¥3.04', text, '本会话 ¥3.04');
  assertAbsent('条形不再列单价', text, '缓存未命中输入');
  assertAbsent('条形不再有倒计时', text, '距空闲');
  assertEqual('每次注册的效果都返回清理函数', effectReturns.every((v) => typeof v === 'function'), true);
}

console.log('\n[2] 展开后的分时段金额与审计数字');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('精确口径标注', text, '按每条请求的发生时刻分时段计价');
  assertMatch('高峰段 tokens 与金额', text, '20.02M tokens · ¥1.9968');
  assertMatch('空闲段 tokens 与金额', text, '34.52M tokens · ¥1.0474');
  assertMatch('分段金额可加出总计', text, '本会话 | ¥3.04');
  assertEqual('两段金额之和 == 总计', Number((1.9968 + 1.0474).toFixed(4)), 3.0442);
  assertMatch('缓存读合计', text, '缓存读 54.11M');
  assertMatch('未缓存输入合计', text, '未缓存输入 249.8K');
  assertMatch('输出合计', text, '输出 178.5K');
  assertMatch('计费口径说明', text, '缓存未命中输入 = 未缓存输入 + 缓存写入');
  assertMatch('子代理说明', text, '子代理是独立会话');
}

console.log('\n[3] Host 投影缺失时退回估算并明确标注');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { expand: true, split: null, totals: REAL_TOTALS });
  // 整段用量全按当前（高峰）价：54.11M×0.04 + 0.249754M×2 + 0.178466M×8 = 4.0916
  assertMatch('估算金额', text, '本会话 ¥4.09');
  assertMatch('标注为估算', text, '估算');
  assertMatch('给出回退警告', text, 'Host 端分时段投影不可用');
}

console.log('\n[4] 无任何用量时显示占位符');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { expand: true, split: null, totals: null });
  assertMatch('金额占位', text, '本会话 --');
  assertMatch('暂无用量', text, '暂无用量记录');
}

console.log('\n[5] 2026-09-30 12:30 北京时间（工作日午休，空闲半价）');
{
  const at = Date.parse('2026-09-30T12:30:00+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('空闲标记', text, '空闲时段');
  assertMatch('午休原因', text, '工作日午休 12:00-14:00');
  assertMatch('距高峰 1 小时 30 分', text, '距高峰 | 1 小时 30 分');
  assertMatch('空闲缓存命中价', text, '缓存命中输入 | ¥0.02 元 / 百万 tokens');
  assertMatch('空闲缓存未命中价', text, '缓存未命中输入 | ¥1 元 / 百万 tokens');
  assertMatch('空闲输出价', text, '输出 | ¥4 元 / 百万 tokens');
  // 空闲单价下的分时段金额 + 空闲档位
  assertMatch('金额随时段重算', text, '本会话');
}

console.log('\n[6] 2026-10-01 10:00 北京时间（国庆节，法定节假日 -> 全天空闲）');
{
  const at = Date.parse('2026-10-01T10:00:00+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('空闲标记', text, '空闲时段');
  assertMatch('节假日原因', text, '国庆节 · 法定节假日全天');
  assertMatch('今天是节假日', text, '今天是国庆节');
  assertMatch('今日全天空闲', text, '全天空闲 —— 国庆节');
  assertMatch('长假倒计时按天', text, '距高峰 | 6 天 23 小时');
}

console.log('\n[7] 2026-10-10 10:00 北京时间（周六调休上班日，周末仍空闲）');
{
  const at = Date.parse('2026-10-10T10:00:00+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('空闲标记', text, '空闲时段');
  assertMatch('周末原因', text, '周末全天');
  assertMatch('今日全天空闲（周末）', text, '全天空闲 —— 周末全天');
}

console.log('\n[8] 2026-09-30 08:00 北京时间（工作日 09:00 前，空闲）');
{
  const at = Date.parse('2026-09-30T08:00:00+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('空闲标记', text, '空闲时段');
  assertMatch('09:00 前', text, '工作日 09:00 前');
  assertMatch('距高峰 1 小时 0 分', text, '距高峰 | 1 小时 0 分');
}

console.log('\n[9] 2026-09-25 10:00 北京时间（中秋节，法定节假日 -> 全天空闲）');
{
  const at = Date.parse('2026-09-25T10:00:00+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('中秋节', text, '中秋节');
  assertMatch('空闲标记', text, '空闲时段');
}

console.log('\n[10] deepseek-v4-pro 高峰单价');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, lastUsed: null },
  });
  assertMatch('pro 模型', text, 'deepseek-v4-pro');
  assertMatch('pro 高峰未命中价 9', text, '缓存未命中输入 | ¥9 元 / 百万 tokens');
  assertMatch('pro 高峰输出价 27', text, '输出 | ¥27 元 / 百万 tokens');
  assertMatch('pro 缓存命中价 0.3', text, '缓存命中输入 | ¥0.3 元 / 百万 tokens');
}

console.log('\n[11] 旧模型名 deepseek-v4-flash 归一到 Flash 价');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, lastUsed: null },
  });
  assertMatch('归一后的模型 id', text, 'deepseek-flash');
  assertMatch('Flash 高峰价', text, '缓存未命中输入 | ¥2 元 / 百万 tokens');
}

console.log('\n[12] 无 modelSelection 投影时用默认模型');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { expand: true, selection: null });
  assertMatch('默认模型', text, 'deepseek-flash');
  assertMatch('默认模型说明', text, '默认模型，会话尚未发起请求');
}

console.log('\n[13] 非 DeepSeek 路由：不估价');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'pi-ai', model: 'some-other-model' }, lastUsed: null },
  });
  assertMatch('非 DeepSeek 提示', text, '未检测到 DeepSeek 路由');
  assertMatch('不显示金额', text, '本会话 --');
}

console.log('\n[14] 未收录模型仍按 Flash 展示并提示');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-future' }, lastUsed: null },
  });
  assertMatch('未收录提示', text, '该模型未收录价目');
  assertMatch('按 Flash 计', text, '缓存未命中输入 | ¥2 元 / 百万 tokens');
}

console.log('\n[15] 金额始终带 ¥ 且不出现美元符号');
{
  for (const iso of ['2026-09-30T09:53:29+08:00', '2026-10-01T10:00:00+08:00']) {
    const { text } = renderAt(Date.parse(iso), { expand: true });
    assertMatch('带人民币符号 @' + iso, text, '本会话 ¥');
    assertAbsent('条形不出现 $ 金额 @' + iso, text, '本会话 $');
  }
}

console.log('\n---- 共 ' + checks + ' 项检查，失败 ' + failures + ' 项 ----');
process.exit(failures === 0 ? 0 : 1);

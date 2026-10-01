/**
 * 离线校验：用最小 React 运行时真机执行 client.js 的注册与渲染路径。
 *
 * 重点验证两件事：
 *   1. 条形只有三格（时段 / 模型 / 金额），展开后只有当前实时单价 —— 不夹带说明性噪音；
 *   2. 时段判定与单价切换正确，且金额只取决于每条请求的发生时刻（不随查看时刻变化）。
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
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  => ' + (ok ? '不含 ' + JSON.stringify(needle) : '意外出现 ' + JSON.stringify(needle)));
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
      if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial;
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

/** 一次真实会话（210 步）的真实分桶用量。 */
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
console.log('\n[1] 条形只有三格：时段 / 模型 / 本会话金额');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text, registered, injected, effectReturns } = renderAt(at);
  assertEqual('注册席位', registered[0].options.name, 'conversation.composer.dock');
  assertEqual('注册 id', registered[0].options.id, 'deepseek-pricing');
  assertEqual('声明的注入服务', injected.join(','), 'conversation.composer.dock');
  assertMatch('时段', text, '高峰时段');
  assertMatch('模型', text, 'deepseek-flash');
  assertMatch('本会话金额', text, '本会话 ¥3.04');
  assertAbsent('条形不带单价', text, '缓存未命中输入');
  assertEqual('每次注册的效果都返回清理函数', effectReturns.every((v) => typeof v === 'function'), true);
}

console.log('\n[2] 展开后只有当前实时单价，没有任何说明性噪音');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { expand: true });
  assertMatch('面板标题', text, '当前实时单价 · 高峰时段');
  assertMatch('命中价', text, '缓存命中输入 | ¥0.04 元 / 百万 tokens');
  assertMatch('未命中价', text, '缓存未命中输入 | ¥2 元 / 百万 tokens');
  assertMatch('输出价', text, '输出 | ¥8 元 / 百万 tokens');

  for (const noise of [
    '北京时间',
    '时段原因',
    '距高峰',
    '距空闲',
    '下一个高峰',
    '今日时段',
    '法定节假日',
    '价目来源',
    '核对时间',
    '计费口径',
    '子代理',
    '两档对照',
    '官方英文价目',
    '分时段',
    'tokens ·',
    '默认模型',
  ]) {
    assertAbsent('展开面板不含「' + noise + '」', text, noise);
  }
}

console.log('\n[3] 时段判定：工作日高峰 / 午休 / 09:00 前 / 18:00 后 / 周末 / 节假日');
{
  const cases = [
    ['2026-09-30T09:53:29+08:00', '高峰时段'],
    ['2026-09-30T12:30:00+08:00', '空闲时段'],
    ['2026-09-30T08:00:00+08:00', '空闲时段'],
    ['2026-09-30T18:30:00+08:00', '空闲时段'],
    ['2026-10-01T10:00:00+08:00', '空闲时段'], // 国庆节
    ['2026-09-25T10:00:00+08:00', '空闲时段'], // 中秋节
    ['2026-10-10T10:00:00+08:00', '空闲时段'], // 周六（调休上班日）
  ];
  for (const [iso, expected] of cases) {
    const { text } = renderAt(Date.parse(iso));
    assertEqual(iso + ' -> ' + expected, text.indexOf(expected) !== -1, true);
  }
}

console.log('\n[4] 单价随时段切换（空闲 = 高峰 × 50%）');
{
  const peak = renderAt(Date.parse('2026-09-30T09:53:29+08:00'), { expand: true });
  assertMatch('高峰命中 ¥0.04', peak.text, '¥0.04 元 / 百万 tokens');
  assertMatch('高峰未命中 ¥2', peak.text, '¥2 元 / 百万 tokens');
  assertMatch('高峰输出 ¥8', peak.text, '¥8 元 / 百万 tokens');

  const off = renderAt(Date.parse('2026-09-30T12:30:00+08:00'), { expand: true });
  assertMatch('空闲命中 ¥0.02', off.text, '¥0.02 元 / 百万 tokens');
  assertMatch('空闲未命中 ¥1', off.text, '¥1 元 / 百万 tokens');
  assertMatch('空闲输出 ¥4', off.text, '¥4 元 / 百万 tokens');
}

console.log('\n[5] 金额只取决于每条请求的发生时刻，不随查看时刻变化');
{
  const late = renderAt(Date.parse('2026-10-01T10:00:00+08:00')); // 国庆节空闲时刻查看
  const early = renderAt(Date.parse('2026-09-30T10:00:00+08:00')); // 高峰时刻查看
  assertMatch('空闲时刻查看的金额', late.text, '本会话 ¥3.04');
  assertMatch('高峰时刻查看的金额', early.text, '本会话 ¥3.04');
  assertMatch('闲置时查看显示空闲标记', late.text, '空闲时段');
  assertMatch('高峰时查看显示高峰标记', early.text, '高峰时段');
}

console.log('\n[6] Host 投影缺失时退回整体估算（金额仍显示）');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { split: null, totals: REAL_TOTALS });
  // 整段用量全按当前（高峰）价：54.11M×0.04 + 0.249754M×2 + 0.178466M×8 = 4.0916
  assertMatch('估算金额', text, '本会话 ¥4.09');
}

console.log('\n[7] 无任何用量时显示占位符');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { split: null, totals: null });
  assertMatch('金额占位', text, '本会话 --');
}

console.log('\n[8] pro 单价');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, lastUsed: null },
  });
  assertMatch('pro 模型名', text, 'deepseek-v4-pro');
  assertMatch('pro 命中 ¥0.3', text, '¥0.3 元 / 百万 tokens');
  assertMatch('pro 未命中 ¥9', text, '¥9 元 / 百万 tokens');
  assertMatch('pro 输出 ¥27', text, '¥27 元 / 百万 tokens');
}

console.log('\n[9] 旧模型名归一到 Flash');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, {
    expand: true,
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, lastUsed: null },
  });
  assertMatch('归一后的模型 id', text, 'deepseek-flash');
  assertMatch('Flash 高峰价', text, '¥2 元 / 百万 tokens');
}

console.log('\n[10] 无 modelSelection 投影时用默认模型');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text } = renderAt(at, { selection: null });
  assertMatch('默认模型', text, 'deepseek-flash');
  assertMatch('仍显示金额', text, '本会话 ¥3.04');
}

console.log('\n[11] 非 DeepSeek 路由：金额不可用，原因放在悬停提示');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text, tree } = renderAt(at, {
    selection: { next: { provider: 'pi-ai', model: 'some-other-model' }, lastUsed: null },
  });
  assertMatch('金额占位', text, '本会话 --');
  const buttons = findAll(tree, (el) => el.type === 'button');
  const hint = buttons.length > 0 ? String(buttons[0].props.title) : '';
  assertMatch('悬停提示说明原因', hint, '未检测到 DeepSeek 路由');
}

console.log('\n[12] 未收录模型：按 Flash 计价，悬停提示里说明');
{
  const at = Date.parse('2026-09-30T09:53:29+08:00');
  const { text, tree } = renderAt(at, {
    selection: { next: { provider: 'deepseek-account', model: 'deepseek-future' }, lastUsed: null },
  });
  assertMatch('按 Flash 计', text, '本会话 ¥3.04');
  const buttons = findAll(tree, (el) => el.type === 'button');
  const hint = buttons.length > 0 ? String(buttons[0].props.title) : '';
  assertMatch('悬停提示说明未收录', hint, '未收录价目');
}

console.log('\n[13] 金额始终带人民币符号');
{
  for (const iso of ['2026-09-30T09:53:29+08:00', '2026-10-01T10:00:00+08:00']) {
    const { text } = renderAt(Date.parse(iso));
    assertMatch('带 ¥ @' + iso, text, '本会话 ¥');
    assertAbsent('不出现 $ 金额 @' + iso, text, '本会话 $');
  }
}

console.log('\n---- 共 ' + checks + ' 项检查，失败 ' + failures + ' 项 ----');
process.exit(failures === 0 ? 0 : 1);

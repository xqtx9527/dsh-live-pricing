/**
 * Host half 的单测：直接折叠合成事件，验证 `deepseekLivePricing` 投影
 * 的峰谷归档、重试替换、引用稳定与 schema 校验。
 *
 * 运行：node test/projection-check.mjs
 */
import { pricingProjection, PRICING_PROJECTION_KEY } from '../index.js';

let failures = 0;
let checks = 0;

function assertEqual(label, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  => ' + JSON.stringify(actual) + (ok ? '' : '  (expected ' + JSON.stringify(expected) + ')'));
}

function assertThrows(label, fn) {
  checks += 1;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
  }
  if (!threw) failures += 1;
  console.log((threw ? '  ok   ' : '  FAIL ') + label);
}

const PEAK_TIME = Date.parse('2026-09-30T10:00:00+08:00'); // 周三上午高峰
const OFF_TIME = Date.parse('2026-09-30T12:30:00+08:00'); // 工作日午休空闲
const HOLIDAY_TIME = Date.parse('2026-10-01T10:00:00+08:00'); // 国庆节，全天空闲
const WEEKEND_TIME = Date.parse('2026-10-10T10:00:00+08:00'); // 周六，全天空闲

function message(turn, step, time, usage) {
  return { type: 'assistant/message', seq: 0, time: time, data: { turn: turn, step: step, usage: usage } };
}

function usage(input, output, cacheRead, cacheWrite) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite === undefined ? 0 : cacheWrite,
    totalTokens: input + output + cacheRead + (cacheWrite === undefined ? 0 : cacheWrite),
  };
}

function fold(events) {
  let state = pricingProjection.init();
  for (const event of events) state = pricingProjection.apply(state, event);
  return state;
}

console.log('\n[1] 投影标识与初始状态');
{
  assertEqual('投影 key', pricingProjection.key, 'deepseekLivePricing');
  assertEqual('导出的 key 常量', PRICING_PROJECTION_KEY, 'deepseekLivePricing');
  assertEqual('stateVersion 为正整数', pricingProjection.stateVersion, 1);
  const init = pricingProjection.init();
  assertEqual('初始两桶为零', [init.peak, init.offPeak], [
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
}

console.log('\n[2] 按事件发生时刻归档到高峰 / 空闲桶');
{
  const state = fold([
    message(1, 1, PEAK_TIME, usage(100, 10, 1000, 0)),
    message(1, 2, OFF_TIME, usage(200, 20, 2000, 0)),
    message(2, 1, HOLIDAY_TIME, usage(300, 30, 3000, 0)),
    message(2, 2, WEEKEND_TIME, usage(400, 40, 4000, 0)),
  ]);
  assertEqual('高峰桶只收高峰时刻', state.peak, {
    uncachedInputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
  });
  assertEqual('空闲桶收午休 + 节假日 + 周末', state.offPeak, {
    uncachedInputTokens: 900,
    outputTokens: 90,
    cacheReadTokens: 9000,
    cacheWriteTokens: 0,
  });
  assertEqual('采样数', state.sampled, 4);
}

console.log('\n[3] 缓存写入计入对应桶');
{
  const state = fold([message(1, 1, PEAK_TIME, usage(10, 1, 100, 500))]);
  assertEqual('高峰桶含 cacheWrite', state.peak.cacheWriteTokens, 500);
}

console.log('\n[4] 无用量的事件不改变状态引用');
{
  const base = fold([message(1, 1, PEAK_TIME, usage(10, 1, 100, 0))]);
  const ignored = [
    { type: 'tool/call', seq: 1, time: PEAK_TIME, data: {} },
    { type: 'step/start', seq: 2, time: PEAK_TIME, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', seq: 3, time: PEAK_TIME, data: { turn: 1, step: 2 } },
  ];
  let state = base;
  for (const event of ignored) state = pricingProjection.apply(state, event);
  assertEqual('引用保持不变（下游 Object.is 门控）', state === base, true);
}

console.log('\n[5] 同一个 turn:step 重采样是替换而不是累加');
{
  const state = fold([
    message(1, 1, PEAK_TIME, usage(1000, 100, 10000, 0)),
    message(1, 1, PEAK_TIME, usage(200, 20, 2000, 0)),
  ]);
  assertEqual('替换后的高峰桶', state.peak, {
    uncachedInputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
  });
}

console.log('\n[6] llm/retry-started 清槽后按新时刻重新归档');
{
  const events = [
    message(1, 1, PEAK_TIME, usage(1000, 100, 10000, 0)),
    { type: 'llm/retry-started', seq: 1, time: PEAK_TIME, data: { turn: 1, step: 1 } },
    message(1, 1, OFF_TIME, usage(200, 20, 2000, 0)),
  ];
  const state = fold(events);
  assertEqual('重试后旧样本已从高峰桶撤掉', state.peak, {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assertEqual('新样本进空闲桶', state.offPeak, {
    uncachedInputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
  });
}

console.log('\n[7] wire 视图只暴露两桶与采样数');
{
  const state = fold([message(1, 1, PEAK_TIME, usage(100, 10, 1000, 0))]);
  const view = pricingProjection.wire.view(state);
  assertEqual('视图字段', Object.keys(view).sort(), ['offPeak', 'peak', 'sampled']);
  assertEqual('视图通过自己的 schema', pricingProjection.wire.viewSchema.parse(view) === view, true);
}

console.log('\n[8] stateSchema / viewSchema 会拒绝坏数据');
{
  assertThrows('state 缺桶时报错', () => pricingProjection.stateSchema.parse({ peak: {}, offPeak: {}, sampled: 0 }));
  assertThrows('桶字段为负时报错', () =>
    pricingProjection.stateSchema.parse({
      peak: { uncachedInputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      offPeak: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sampled: 0,
    }));
  assertThrows('sampled 缺失时报错', () =>
    pricingProjection.wire.viewSchema.parse({
      peak: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      offPeak: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
  assertEqual(
    '合法 state 原样返回',
    pricingProjection.stateSchema.parse(pricingProjection.init()) !== null,
    true,
  );
}

console.log('\n[9] 金额口径自洽（用 0.3.0 的单价复算）');
{
  const state = fold([
    message(1, 1, PEAK_TIME, usage(1000000, 1000000, 1000000, 0)),
    message(1, 2, OFF_TIME, usage(1000000, 1000000, 1000000, 0)),
  ]);
  const cost = (b, hit, miss, out) =>
    (b.cacheReadTokens / 1e6) * hit + (b.uncachedInputTokens + b.cacheWriteTokens) / 1e6 * miss + (b.outputTokens / 1e6) * out;
  const total = cost(state.peak, 0.04, 2, 8) + cost(state.offPeak, 0.02, 1, 4);
  // 高峰：1×0.04 + 1×2 + 1×8 = 10.04；空闲：1×0.02 + 1×1 + 1×4 = 5.02
  assertEqual('高峰段 1M 各桶 = ¥10.04', Number(cost(state.peak, 0.04, 2, 8).toFixed(4)), 10.04);
  assertEqual('空闲段 1M 各桶 = ¥5.02', Number(cost(state.offPeak, 0.02, 1, 4).toFixed(4)), 5.02);
  assertEqual('合计 ¥15.06', Number(total.toFixed(4)), 15.06);
}

console.log('\n---- 共 ' + checks + ' 项检查，失败 ' + failures + ' 项 ----');
process.exit(failures === 0 ? 0 : 1);

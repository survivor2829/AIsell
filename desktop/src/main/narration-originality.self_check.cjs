const assert = require('node:assert/strict');
const { overlap, scriptOriginality, scriptStructure } = require('./narration-originality.cjs');

// 与云端测试用同一组例子，两边算法结果必须一致
const reference = { title: '', body: '物业经理千万别再招保洁了，一台洗地机顶六个人' };
assert.equal(overlap('物业经理千万别再招保洁了！一台洗地机顶六个人', reference).ratio, 1);
const partial = overlap('夜班保洁排不开人？物业经理千万别再招保洁了。先看地面再试机。', reference);
assert.deepEqual(partial.fragments, ['物业经理千万别再招保洁了']);
assert.ok(Math.abs(partial.ratio - 12 / 27) < 1e-9);
assert.equal(overlap('先看物业经理千万别乱买设备', reference).ratio, 0, '7 个字的巧合不算照抄');
assert.equal(scriptOriginality('任何文案', null), null, '没有参考不检查');

const copied = scriptOriginality('物业经理千万别再招保洁了，一台洗地机顶六个人。', reference, { attempts: 2 });
assert.deepEqual({ ...copied, fragments: undefined }, { overlapRatio: 1, limit: 0.15, attempts: 2, passed: false, fragments: undefined });
const original = scriptOriginality('你还在为夜班保洁排不开人发愁吗？先看地面材质，再算清洁面积。', reference, { attempts: 99 });
assert.equal(original.passed, true);
assert.equal(original.attempts, 1, '云端回执里不认识的重写次数按 1 次算');

assert.deepEqual(scriptStructure([{ part: '钩子', method: ' 开头一句反问 ' }, { part: '乱写', method: 'x' }, '坏数据', { part: '证据', method: '' }]), [{ part: '钩子', method: '开头一句反问' }]);
assert.deepEqual(scriptStructure('不是数组'), []);

console.log('narration originality self-check passed: 8-character copied runs, same cases as gateway, no reference no check, structure filtering');

/*
 * 验收测试：模拟 4 个标签页 + 可乱序/可断开的广播总线 + 共享 IndexedDB
 * 运行：node test/sync.test.cjs
 */
'use strict';

const TodoSync = require('../sync.js');
const assert = require('node:assert');

// ---------- 共享 IndexedDB 模拟（同源标签页共享同一个库） ----------
function createSharedDB() {
  const data = new Map();
  return {
    async getAllOps() {
      return Array.from(data.values()).map((o) => ({ ...o }));
    },
    async putOp(op) {
      data.set(op.opId, { ...op });
    },
  };
}

// ---------- 广播总线：随机延迟投递（模拟消息乱序），支持离线分区 ----------
function createBus() {
  const handlers = new Map(); // tabId -> fn
  const offline = new Set();
  return {
    connect(tabId, fn) { handlers.set(tabId, fn); },
    disconnect(tabId) { handlers.delete(tabId); },
    setOffline(tabId, flag) { flag ? offline.add(tabId) : offline.delete(tabId); },
    post(from, msg) {
      if (offline.has(from)) return;
      for (const [id, fn] of handlers) {
        if (id === from || offline.has(id)) continue;
        const copy = JSON.parse(JSON.stringify(msg));
        setTimeout(() => fn(copy), Math.floor(Math.random() * 20)); // 乱序
      }
    },
  };
}

function channelFor(bus, tabId) {
  return {
    post: (msg) => bus.post(tabId, msg),
    onMessage: (fn) => bus.connect(tabId, fn),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(80); // 等所有在途消息投递完

async function openTab(bus, db, tabId) {
  const session = TodoSync.createSession({
    tabId,
    store: db,
    channel: channelFor(bus, tabId),
  });
  await session.ready;
  return session;
}

function statesEqual(tabs) {
  const snapshot = JSON.stringify(tabs[0].getItems());
  for (const t of tabs) {
    assert.strictEqual(JSON.stringify(t.getItems()), snapshot, '标签页状态不一致');
  }
  return tabs[0].getItems();
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// 1. 4 个标签页同时添加 -> 清单一致
test('4 个标签页同时添加后清单一致', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const tabs = await Promise.all([1, 2, 3, 4].map((i) => openTab(bus, db, 'tab' + i)));
  await Promise.all(
    tabs.flatMap((t, i) => [0, 1, 2, 3, 4].map((j) => t.addTodo(`tab${i + 1}-任务${j}`)))
  );
  await settle();
  const items = statesEqual(tabs);
  assert.strictEqual(items.length, 20, '应有 20 条');
  for (const t of tabs) bus.disconnect(t.tabId);
});

// 2. 同时完成同一条 -> 收敛到同一结果
test('两个标签页同时完成/取消同一条，结果一致', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const [a, b] = await Promise.all([openTab(bus, db, 'A'), openTab(bus, db, 'B')]);
  await a.addTodo('被同时勾选的任务');
  await settle();
  const id = a.getItems()[0].id;
  // 同时勾选：A 设为完成，B 也基于自己的视图切换
  await Promise.all([a.setCompleted(id, true), b.setCompleted(id, true)]);
  await settle();
  const items = statesEqual([a, b]);
  assert.strictEqual(items[0].completed, true);
  bus.disconnect('A'); bus.disconnect('B');
});

// 3. 同时删除同一条 -> 不重复、不报错、彻底消失
test('两个标签页同时删除同一条，不重复且一致', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const [a, b] = await Promise.all([openTab(bus, db, 'A'), openTab(bus, db, 'B')]);
  await a.addTodo('要被同时删除的任务');
  await settle();
  const id = a.getItems()[0].id;
  await Promise.all([a.deleteTodo(id), b.deleteTodo(id), a.deleteTodo(id)]); // 重复删
  await settle();
  const items = statesEqual([a, b]);
  assert.strictEqual(items.length, 0, '删除后应为空');
  const opsA = a.getOps().filter((o) => o.type === 'delete' && o.itemId === id);
  assert.strictEqual(opsA.length, 3, '删除操作各自记录但幂等合并');
  bus.disconnect('A'); bus.disconnect('B');
});

// 4. 离线操作后恢复 -> 合并正确
test('离线标签页的操作在恢复后正确合并', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const [a, b, c] = await Promise.all([openTab(bus, db, 'A'), openTab(bus, db, 'B'), openTab(bus, db, 'C')]);
  await a.addTodo('在线任务');
  await settle();
  const onlineId = a.getItems()[0].id;

  // C 离线，期间各自操作
  bus.setOffline('C', true);
  await c.addTodo('C 离线时添加');
  await c.setCompleted(onlineId, true);          // 离线勾选在线任务
  await a.addTodo('A 在 C 离线时添加');
  await b.deleteTodo(onlineId);                   // B 删掉了 C 勾选的那条
  await settle();

  assert.strictEqual(a.getItems().length, 1, 'A 视角：在线任务被删，只剩自己新增的');
  assert.strictEqual(c.getItems().length, 2, 'C 离线视角：看不到 A/B 的操作');

  // C 恢复，触发反熵
  bus.setOffline('C', false);
  c.requestSync();
  a.requestSync();
  b.requestSync();
  await settle();

  const items = statesEqual([a, b, c]);
  const texts = items.map((i) => i.text).sort();
  assert.deepStrictEqual(texts, ['A 在 C 离线时添加', 'C 离线时添加'].sort());
  // delete 是墓碑：C 离线时对 onlineId 的 setCompleted 不会让它复活
  assert.ok(!items.some((i) => i.id === onlineId), '被删任务不应复活');
  for (const t of [a, b, c]) bus.disconnect(t.tabId);
});

// 5. 消息乱序 -> 不丢操作
test('消息乱序投递不丢操作', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const tabs = await Promise.all([1, 2, 3, 4].map((i) => openTab(bus, db, 'T' + i)));
  // 高并发混合操作，总线随机延迟 => 大量乱序
  const added = await Promise.all(
    tabs.flatMap((t, i) => [0, 1, 2].map((j) => t.addTodo(`乱序-${i}-${j}`)))
  );
  const ids = added.map((op) => op.itemId);
  await Promise.all([
    tabs[0].setCompleted(ids[3], true),
    tabs[1].setCompleted(ids[3], false),
    tabs[2].setCompleted(ids[3], true),
    tabs[3].deleteTodo(ids[7]),
    tabs[0].deleteTodo(ids[7]),
    tabs[1].setCompleted(ids[7], true), // 对已删项的迟到操作
  ]);
  await settle();
  const items = statesEqual(tabs);
  assert.strictEqual(items.length, 11, '12 条添加 - 1 条删除');
  // 并发冲突按 (ts, opId) LWW 决定胜负，验证结果等于确定的赢家而非随机
  const cOps = tabs[0].getOps().filter((o) => o.type === 'setCompleted' && o.itemId === ids[3]);
  const winner = cOps.reduce((a, b) =>
    a.ts !== b.ts ? (a.ts > b.ts ? a : b) : a.opId > b.opId ? a : b
  );
  assert.strictEqual(items.find((i) => i.id === ids[3]).completed, winner.completed);
  assert.ok(!items.some((i) => i.id === ids[7]));
  // 操作日志条数也应一致（不丢操作）
  const opCount = tabs[0].getOps().length;
  for (const t of tabs) assert.strictEqual(t.getOps().length, opCount, '操作日志条数不一致');
  for (const t of tabs) bus.disconnect(t.tabId);
});

// 6. 刷新任意标签页 -> 从 IndexedDB 恢复，清单一致
test('刷新标签页后清单一致', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const a = await openTab(bus, db, 'A');
  await a.addTodo('刷新前任务1');
  await a.addTodo('刷新前任务2');
  await a.setCompleted(a.getItems()[0].id, true);
  await settle();
  const before = JSON.stringify(a.getItems());
  bus.disconnect('A');

  // 模拟刷新：同一共享 DB，全新会话，不接收任何广播
  const bus2 = createBus();
  const a2 = await openTab(bus2, db, 'A-reloaded');
  assert.strictEqual(JSON.stringify(a2.getItems()), before, '刷新后清单应一致');
  bus2.disconnect('A-reloaded');
});

// 7. 标签页关闭后数据不丢，重开后能同步到新状态
test('标签页关闭后数据不丢，重开合并新操作', async () => {
  const bus = createBus();
  const db = createSharedDB();
  const a = await openTab(bus, db, 'A');
  const b = await openTab(bus, db, 'B');
  await a.addTodo('关闭前的任务');
  await settle();

  // B 关闭（断开广播），期间 A 继续操作
  bus.disconnect('B');
  await a.addTodo('B 关闭期间 A 添加');
  await a.deleteTodo(a.getItems()[0].id);
  await settle();

  // B 重新打开：从共享 DB 读到全部操作（同一 IndexedDB），再反熵对齐
  const b2 = await openTab(bus, db, 'B2');
  b2.requestSync();
  await settle();
  const items = statesEqual([a, b2]);
  assert.deepStrictEqual(items.map((i) => i.text), ['B 关闭期间 A 添加']);
  bus.disconnect('A'); bus.disconnect('B2');
});

// ---------- 运行 ----------
(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${name}`);
      console.error('  ' + err.message);
    }
  }
  await sleep(50);
  console.log(failed === 0 ? `\n全部 ${tests.length} 项验收测试通过` : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();

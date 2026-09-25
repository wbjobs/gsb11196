/*
 * 验收模拟：用 Node 模拟 4 个标签页 + 共享 IndexedDB + 可控消息总线。
 * 运行：node test/simulate.js
 */
'use strict';

const assert = require('assert');
const { TodoStore } = require('../sync.js');

// ---- 共享的"IndexedDB"：所有标签页读写同一个 Map（事实源）----
const sharedDb = new Map(); // opId -> op

// ---- 可控消息总线：模拟 BroadcastChannel，支持乱序/延迟/断连 ----
const bus = {
  queue: [], // 待投递消息 {op, from}
  deliver(toTabs) {
    for (const { op, from } of this.queue) {
      for (const tab of toTabs) {
        if (tab.online && tab.tabId !== from) tab.receive(op);
      }
    }
    this.queue = [];
  },
  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  },
};

let tabCounter = 0;

class Tab {
  constructor() {
    this.tabId = 'tab-' + ++tabCounter;
    this.store = new TodoStore(this.tabId);
    this.online = true;
    this.resync(); // 启动时从 IDB 全量加载
  }
  // 本地动作：先写 IDB，再应用，再广播（与 app.js 的 commit 一致）
  commit(partial) {
    const op = this.store.makeOp(partial);
    sharedDb.set(op.opId, op); // persistOp
    this.store.applyOp(op);
    if (this.online) bus.queue.push({ op, from: this.tabId }); // 离线时广播不可用
  }
  receive(op) {
    if (this.store.applyOp(op)) sharedDb.set(op.opId, op);
  }
  resync() {
    for (const op of sharedDb.values()) this.store.applyOp(op);
  }
  state() {
    return this.store.getState();
  }
}

function assertConsistent(tabs, msg) {
  const ref = JSON.stringify(tabs[0].state());
  for (const tab of tabs) {
    assert.strictEqual(JSON.stringify(tab.state()), ref, msg);
  }
}

// 每个场景相当于一个全新的浏览器环境（清空 IDB 与在途消息）
function reset() {
  sharedDb.clear();
  bus.queue = [];
}

// ============ 场景 1：4 个标签页并发添加/完成，最终一致 ============
{
  reset();
  const tabs = [new Tab(), new Tab(), new Tab(), new Tab()];
  tabs.forEach((tab, i) => tab.commit({ type: 'add', itemId: 'item-' + i, text: '任务' + i }));
  bus.shuffle(); // 乱序投递
  bus.deliver(tabs);
  // 每个标签页完成别人的一条
  tabs.forEach((tab, i) =>
    tab.commit({ type: 'set-completed', itemId: 'item-' + ((i + 1) % 4), completed: true })
  );
  bus.shuffle();
  bus.deliver(tabs);
  assertConsistent(tabs, '场景1：4 标签页并发操作后应一致');
  assert.strictEqual(tabs[0].state().length, 4, '场景1：应有 4 条');
  console.log('✓ 场景1：4 个标签页并发添加/完成，清单一致');
}

// ============ 场景 2：两个标签页同时删除同一条，不重复 ============
{
  reset();
  const a = new Tab();
  const b = new Tab();
  a.commit({ type: 'add', itemId: 'item-x', text: 'X' });
  bus.deliver([a, b]);
  a.commit({ type: 'delete', itemId: 'item-x' });
  b.commit({ type: 'delete', itemId: 'item-x' }); // 并发删除同一条
  bus.deliver([a, b]);
  assertConsistent([a, b], '场景2：并发删除后应一致');
  assert.strictEqual(a.state().length, 0, '场景2：条目应被删除且只删一次');
  console.log('✓ 场景2：同时删除同一条不重复（幂等）');
}

// ============ 场景 3：离线操作，恢复后合并正确 ============
{
  reset();
  const online = new Tab();
  const offline = new Tab();
  online.commit({ type: 'add', itemId: 'item-a', text: 'A' });
  bus.deliver([online, offline]);

  offline.online = false; // 断网：收不到广播，但本地照常操作（写 IDB）
  offline.commit({ type: 'add', itemId: 'item-b', text: 'B（离线添加）' });
  offline.commit({ type: 'set-completed', itemId: 'item-a', completed: true });
  online.commit({ type: 'add', itemId: 'item-c', text: 'C' });
  bus.deliver([online, offline]); // offline 收不到
  assert.strictEqual(online.state().length, 2, '场景3：在线页看不到离线操作');

  offline.online = true;
  offline.resync(); // 恢复后从 IDB 合并
  online.resync();
  bus.deliver([online, offline]);
  assertConsistent([online, offline], '场景3：恢复后应一致');
  assert.strictEqual(online.state().length, 3, '场景3：离线条目应合并进来');
  assert.strictEqual(
    online.state().find((i) => i.id === 'item-a').completed,
    true,
    '场景3：离线期间的完成操作应生效'
  );
  console.log('✓ 场景3：离线操作恢复后合并正确');
}

// ============ 场景 4：消息乱序不丢操作 ============
{
  reset();
  const sender = new Tab();
  const receiver = new Tab();
  sender.commit({ type: 'add', itemId: 'item-1', text: '1' });
  sender.commit({ type: 'add', itemId: 'item-2', text: '2' });
  sender.commit({ type: 'set-completed', itemId: 'item-1', completed: true });
  sender.commit({ type: 'delete', itemId: 'item-2' });
  // 极端乱序：完全反转投递顺序
  bus.queue.reverse();
  bus.deliver([sender, receiver]);
  assertConsistent([sender, receiver], '场景4：乱序后应一致');
  const st = receiver.state();
  assert.strictEqual(st.length, 1, '场景4：item-2 应被删除');
  assert.strictEqual(st[0].completed, true, '场景4：item-1 应已完成');
  console.log('✓ 场景4：消息乱序（逆序投递）不丢操作、结果正确');
}

// ============ 场景 5：刷新任意标签页后清单一致 ============
{
  reset();
  const keep = new Tab();
  keep.commit({ type: 'add', itemId: 'item-r1', text: 'R1' });
  keep.commit({ type: 'add', itemId: 'item-r2', text: 'R2' });
  bus.deliver([keep]);
  const refreshed = new Tab(); // 新 tabId + 从 IDB 全量加载 = 刷新
  assertConsistent([keep, refreshed], '场景5：刷新后应一致');
  assert.strictEqual(refreshed.state().length, 2, '场景5：刷新后数据完整');
  console.log('✓ 场景5：刷新标签页后清单一致');
}

// ============ 场景 6：标签页关闭后数据不丢 ============
{
  reset();
  const tab = new Tab();
  tab.commit({ type: 'add', itemId: 'item-persist', text: '关掉我也行' });
  bus.deliver([tab]);
  // tab 被关闭（对象丢弃），不投递任何消息
  const reopened = new Tab(); // 之后任意时刻重新打开
  assert.ok(
    reopened.state().some((i) => i.id === 'item-persist'),
    '场景6：关闭标签页后数据应保留在 IndexedDB'
  );
  console.log('✓ 场景6：标签页关闭后数据不丢');
}

console.log('\n全部 6 个验收场景通过 ✅');

/*
 * sync.js — 待办清单同步核心（与 DOM / IndexedDB / BroadcastChannel 无关）
 *
 * 设计：操作日志（op log）+ LWW（Last-Write-Wins）
 * - 每个操作是不可变记录：{ opId, tabId, ts, type, itemId, ... }
 *   type: 'add' | 'setCompleted' | 'delete'
 * - 所有操作持久化到 IndexedDB，状态由操作日志折叠（reduce）得出
 * - 操作之间满足交换律、结合律、幂等律 => 任意顺序合并都收敛到同一状态
 *   · add:        itemId 唯一，重复 add 取 ts 最小者（去重）
 *   · setCompleted: 同一 item 取 (ts, opId) 最大者（LWW，并发完成结果确定）
 *   · delete:     墓碑（tombstone），幂等，并发删除同一条不会重复/复活
 * - 反熵（anti-entropy）：标签页通过 hello/sync 消息交换缺失操作，
 *   离线期间产生的操作在恢复后自动合并
 */
(function (global) {
  'use strict';

  function randomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // 比较 (ts, id) 二元组：先比逻辑时间戳，再比 opId 保证全局确定顺序
  function compareMarker(tsA, idA, tsB, idB) {
    if (tsA !== tsB) return tsA < tsB ? -1 : 1;
    if (idA === idB) return 0;
    return idA < idB ? -1 : 1;
  }

  // 把操作日志折叠成可见清单（顺序无关，任意子集/乱序结果一致）
  function reduceOps(ops) {
    const items = new Map();
    function entry(itemId) {
      let e = items.get(itemId);
      if (!e) {
        e = {
          id: itemId, text: '', hasAdd: false, addTs: 0, addOpId: '',
          completed: false, cTs: 0, cOpId: '', deleted: false,
        };
        items.set(itemId, e);
      }
      return e;
    }
    for (const op of ops) {
      if (!op || !op.itemId) continue;
      const e = entry(op.itemId);
      if (op.type === 'add') {
        if (!e.hasAdd || compareMarker(op.ts, op.opId, e.addTs, e.addOpId) < 0) {
          e.hasAdd = true; e.addTs = op.ts; e.addOpId = op.opId; e.text = op.text;
        }
      } else if (op.type === 'setCompleted') {
        if (!e.cOpId || compareMarker(op.ts, op.opId, e.cTs, e.cOpId) > 0) {
          e.cTs = op.ts; e.cOpId = op.opId; e.completed = !!op.completed;
        }
      } else if (op.type === 'delete') {
        e.deleted = true; // 墓碑：一旦删除不再复活（重新添加会生成新 itemId）
      }
    }
    return Array.from(items.values())
      .filter((e) => e.hasAdd && !e.deleted)
      .sort((a, b) => compareMarker(a.addTs, a.addOpId, b.addTs, b.addOpId))
      .map((e) => ({ id: e.id, text: e.text, completed: e.completed }));
  }

  /*
   * 创建一个同步会话（一个标签页一个会话）。
   * options:
   *   tabId    标签页唯一 id（可选）
   *   store    持久层：{ getAllOps(): Promise<op[]>, putOp(op): Promise }
   *   channel  广播层：{ post(msg), onMessage(fn) }
   *   onChange 状态变化回调，参数为可见清单数组
   */
  function createSession(options) {
    const tabId = options.tabId || randomId();
    const store = options.store;
    const channel = options.channel;
    const onChange = typeof options.onChange === 'function' ? options.onChange : function () {};

    const ops = new Map();   // opId -> op（内存中的完整操作日志）
    let lastTs = 0;          // 单调逻辑时钟，保证本标签页内 ts 唯一且递增
    let ready = false;
    const pendingMsgs = [];  // 初始化完成前收到的消息先排队，避免丢操作

    function nextTs() {
      const now = Date.now();
      lastTs = now > lastTs ? now : lastTs + 1;
      return lastTs;
    }

    // 幂等合并：已见过的 opId 直接忽略（同时删除/重复投递不会重复生效）
    function mergeOp(op) {
      if (!op || !op.opId || ops.has(op.opId)) return false;
      ops.set(op.opId, op);
      return true;
    }

    function getItems() {
      return reduceOps(ops.values());
    }

    function notify() {
      onChange(getItems());
    }

    function handleOp(op) {
      if (mergeOp(op)) {
        store.putOp(op); // 先持久化，刷新/关闭标签页不丢
        notify();
      }
    }

    function processMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'op') {
        handleOp(msg.op);
      } else if (msg.kind === 'hello') {
        // 有标签页上线/请求同步：把完整操作日志发给它（反熵）
        if (msg.from === tabId) return;
        channel.post({ kind: 'sync', to: msg.from, ops: Array.from(ops.values()) });
      } else if (msg.kind === 'sync') {
        if (msg.to !== tabId) return;
        let changed = false;
        const list = Array.isArray(msg.ops) ? msg.ops : [];
        for (const op of list) {
          if (mergeOp(op)) { store.putOp(op); changed = true; }
        }
        if (changed) notify();
      }
    }

    function onMessage(msg) {
      if (!ready) { pendingMsgs.push(msg); return; }
      processMessage(msg);
    }

    function localOp(type, fields) {
      const op = Object.assign(
        { opId: randomId(), tabId: tabId, ts: nextTs(), type: type },
        fields
      );
      mergeOp(op);
      notify();
      // 先写 IndexedDB 再广播：即使广播失败/对方离线，数据也不丢，
      // 对方恢复后通过 hello/sync 反熵拿到这条操作
      return Promise.resolve(store.putOp(op)).then(function () {
        channel.post({ kind: 'op', op: op });
        return op;
      });
    }

    const readyPromise = Promise.resolve()
      .then(function () { return store.getAllOps(); })
      .then(function (stored) {
        for (const op of stored || []) mergeOp(op);
        ready = true;
        for (const msg of pendingMsgs) processMessage(msg);
        pendingMsgs.length = 0;
        notify();
      });

    channel.onMessage(onMessage);

    return {
      tabId: tabId,
      ready: readyPromise,
      getItems: getItems,
      getOps: function () { return Array.from(ops.values()); },
      addTodo: function (text) {
        return localOp('add', { itemId: randomId(), text: String(text) });
      },
      setCompleted: function (itemId, completed) {
        return localOp('setCompleted', { itemId: itemId, completed: !!completed });
      },
      toggle: function (itemId) {
        const item = getItems().find(function (i) { return i.id === itemId; });
        if (!item) return Promise.resolve(null);
        return this.setCompleted(itemId, !item.completed);
      },
      deleteTodo: function (itemId) {
        return localOp('delete', { itemId: itemId });
      },
      // 主动发起反熵同步：启动、网络恢复、页面重新可见时调用
      requestSync: function () {
        channel.post({ kind: 'hello', from: tabId });
      },
    };
  }

  const TodoSync = { createSession: createSession, reduceOps: reduceOps, randomId: randomId };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TodoSync; // Node（测试用）
  } else {
    global.TodoSync = TodoSync; // 浏览器
  }
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * 核心同步逻辑：操作日志（op-log）+ Lamport 时钟。
 * 浏览器和 Node（测试）共用，不依赖 DOM / IndexedDB / BroadcastChannel。
 *
 * 收敛原理：
 * - 每个操作有全局唯一 opId（tabId-seq），重复投递幂等。
 * - 所有操作按 (lamport, tabId, seq) 全序排序后重放，结果确定。
 * - 有因果关系的操作（如先 add 后 toggle）Lamport 时钟保证其顺序。
 * - 并发操作规则可交换：add 幂等插入；set-completed 携带目标值而非"取反"；
 *   delete 是终态（墓碑），并发 delete 同一条只生效一次。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TodoSync = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function compareOps(a, b) {
    if (a.lamport !== b.lamport) return a.lamport - b.lamport;
    if (a.tabId !== b.tabId) return a.tabId < b.tabId ? -1 : 1;
    return a.seq - b.seq;
  }

  function compareItems(a, b) {
    if (a.createdLamport !== b.createdLamport) return a.createdLamport - b.createdLamport;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  class TodoStore {
    constructor(tabId) {
      this.tabId = tabId;
      this.seq = 0;
      this.clock = 0;
      this.ops = new Map(); // opId -> op
    }

    // 生成本地操作（尚未入库）
    makeOp(partial) {
      this.clock += 1;
      this.seq += 1;
      return Object.assign({}, partial, {
        opId: this.tabId + '-' + this.seq,
        tabId: this.tabId,
        seq: this.seq,
        lamport: this.clock,
      });
    }

    // 应用一条操作；返回 true 表示是新操作，false 表示重复（幂等跳过）
    applyOp(op) {
      if (!op || typeof op.opId !== 'string') return false;
      if (this.ops.has(op.opId)) return false;
      this.ops.set(op.opId, op);
      if (op.lamport > this.clock) this.clock = op.lamport;
      // 本地 seq 至少追上同 tab 已见序号，避免刷新后 opId 冲突
      if (op.tabId === this.tabId && op.seq >= this.seq) this.seq = op.seq;
      return true;
    }

    hasOp(opId) {
      return this.ops.has(opId);
    }

    // 将操作日志按全序重放，得到当前可见清单
    getState() {
      const items = new Map();
      const sorted = Array.from(this.ops.values()).sort(compareOps);
      for (const op of sorted) {
        if (op.type === 'add') {
          if (!items.has(op.itemId)) {
            items.set(op.itemId, {
              id: op.itemId,
              text: op.text,
              completed: false,
              deleted: false,
              createdLamport: op.lamport,
            });
          }
        } else if (op.type === 'set-completed') {
          const item = items.get(op.itemId);
          if (item && !item.deleted) item.completed = !!op.completed;
        } else if (op.type === 'delete') {
          const item = items.get(op.itemId);
          if (item) item.deleted = true; // 墓碑：终态，之后的完成操作不再生效
        }
      }
      return Array.from(items.values())
        .filter((item) => !item.deleted)
        .sort(compareItems);
    }
  }

  return { TodoStore, compareOps };
});

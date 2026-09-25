/*
 * 页面装配：IndexedDB（事实源）+ BroadcastChannel（实时通知）+ DOM 渲染。
 *
 * 写路径：本地动作 -> 生成 op -> 先写 IndexedDB -> 应用到内存 -> 广播 -> 渲染。
 * 收路径：收到广播 -> 幂等应用 -> 新 op 落库 -> 渲染。
 * 兜底：启动 / 窗口聚焦 / 网络恢复时，从 IndexedDB 全量重放，
 *       因此消息丢失、乱序、离线期间的变更都能合并回来。
 */
(function () {
  'use strict';

  const DB_NAME = 'todo-sync-db';
  const DB_VERSION = 1;
  const STORE = 'ops';
  const CHANNEL = 'todo-sync-channel';

  // 每个标签页一个随机 tabId（刷新后变更没关系，opId 唯一性靠 tabId+seq，
  // 而 seq 会在加载历史日志后追平，不会与历史 op 冲突）
  const tabId =
    'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  const store = new TodoSync.TodoStore(tabId);
  let db = null;
  let channel = null;

  // ---------- IndexedDB ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'opId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }

  function persistOp(op) {
    return tx('readwrite', (s) => s.put(op));
  }

  function loadAllOps() {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- 同步 ----------

  // 本地动作统一入口：先落库（保证刷新/关标签页不丢），再广播
  async function commit(partial) {
    const op = store.makeOp(partial);
    await persistOp(op);
    store.applyOp(op);
    if (channel) channel.postMessage(op);
    render();
  }

  // 从 IndexedDB 全量重放，合并离线期间或其他标签页写入的操作
  async function resync() {
    const ops = await loadAllOps();
    let changed = false;
    for (const op of ops) {
      if (store.applyOp(op)) changed = true;
    }
    if (changed) render();
  }

  function onMessage(event) {
    const op = event.data;
    if (!op || op.tabId === tabId) return; // 不处理自己发的
    if (store.applyOp(op)) {
      persistOp(op).catch((err) => console.error('persist failed', err));
      render();
    }
  }

  // ---------- DOM ----------

  const input = document.getElementById('new-todo');
  const addBtn = document.getElementById('add-btn');
  const listEl = document.getElementById('todo-list');
  const countEl = document.getElementById('count');

  function render() {
    const items = store.getState();
    listEl.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = item.completed ? 'completed' : '';
      li.dataset.itemId = item.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.completed;
      checkbox.addEventListener('change', () => {
        commit({ type: 'set-completed', itemId: item.id, completed: checkbox.checked });
      });

      const label = document.createElement('span');
      label.className = 'text';
      label.textContent = item.text;

      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        commit({ type: 'delete', itemId: item.id });
      });

      li.appendChild(checkbox);
      li.appendChild(label);
      li.appendChild(del);
      listEl.appendChild(li);
    }
    const remaining = items.filter((i) => !i.completed).length;
    countEl.textContent = '共 ' + items.length + ' 条，剩余 ' + remaining + ' 条未完成';
  }

  function addFromInput() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const itemId =
      'item-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    commit({ type: 'add', itemId, text });
  }

  addBtn.addEventListener('click', addFromInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFromInput();
  });

  // ---------- 启动 ----------

  async function init() {
    db = await openDb();
    await resync(); // 启动时全量重放：刷新/重开标签页后清单一致

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = onMessage;
    }

    // 兜底重同步：覆盖离线恢复、页面被挂起后唤醒等漏消息场景
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resync();
    });
    window.addEventListener('online', resync);
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) resync(); // 从 bfcache 恢复
    });

    render();
  }

  init().catch((err) => console.error('init failed', err));
})();

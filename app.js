/* app.js — 把 sync.js 接到 IndexedDB + BroadcastChannel + DOM 上 */
(function () {
  'use strict';

  var DB_NAME = 'todo-sync';
  var STORE = 'ops';
  var CHANNEL_NAME = 'todo-sync-v1';

  // ---------- IndexedDB 持久层（同源所有标签页共享） ----------
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'opId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function createStore(db) {
    return {
      getAllOps: function () {
        var tx = db.transaction(STORE, 'readonly');
        return idbRequest(tx.objectStore(STORE).getAll());
      },
      putOp: function (op) {
        var tx = db.transaction(STORE, 'readwrite');
        return idbRequest(tx.objectStore(STORE).put(op)).then(function () {
          return new Promise(function (resolve, reject) {
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
          });
        });
      },
    };
  }

  // ---------- BroadcastChannel 广播层 ----------
  function createChannel() {
    var bc = new BroadcastChannel(CHANNEL_NAME);
    return {
      post: function (msg) { bc.postMessage(msg); },
      onMessage: function (fn) {
        bc.onmessage = function (e) { fn(e.data); };
      },
    };
  }

  // ---------- DOM 渲染 ----------
  var listEl = document.getElementById('todo-list');
  var formEl = document.getElementById('todo-form');
  var inputEl = document.getElementById('todo-input');
  var emptyEl = document.getElementById('empty-tip');
  var statusEl = document.getElementById('sync-status');

  function render(items) {
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    for (var i = 0; i < items.length; i++) {
      listEl.appendChild(buildItem(items[i]));
    }
  }

  function buildItem(item) {
    var li = document.createElement('li');
    li.className = 'todo-item' + (item.completed ? ' done' : '');
    li.dataset.id = item.id;

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.completed;
    checkbox.className = 'toggle';
    checkbox.setAttribute('aria-label', '完成');

    var span = document.createElement('span');
    span.className = 'text';
    span.textContent = item.text;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = '删除';

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(del);
    return li;
  }

  // ---------- 启动 ----------
  openDB().then(function (db) {
    var session = TodoSync.createSession({
      store: createStore(db),
      channel: createChannel(),
      onChange: render,
    });

    formEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      session.addTodo(text);
    });

    // 事件委托：勾选完成 / 删除
    listEl.addEventListener('click', function (e) {
      var li = e.target.closest('.todo-item');
      if (!li) return;
      if (e.target.classList.contains('delete')) {
        session.deleteTodo(li.dataset.id);
      }
    });
    listEl.addEventListener('change', function (e) {
      var li = e.target.closest('.todo-item');
      if (!li || !e.target.classList.contains('toggle')) return;
      session.setCompleted(li.dataset.id, e.target.checked);
    });

    // 反熵触发点：启动后、网络恢复、页面重新可见时各同步一次，
    // 保证离线期间的操作在恢复后合并到所有标签页
    session.ready.then(function () {
      session.requestSync();
      statusEl.textContent = '已同步 · 标签页 ' + session.tabId.slice(0, 8);
    });
    window.addEventListener('online', function () { session.requestSync(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) session.requestSync();
    });
  }).catch(function (err) {
    statusEl.textContent = '初始化失败：' + err;
  });
})();

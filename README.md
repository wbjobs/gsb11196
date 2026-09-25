# 多标签页实时同步待办清单

纯前端实现：BroadcastChannel + IndexedDB + DOM，无构建、无依赖。

## 运行

```bash
# 任选其一，在本目录启动静态服务（BroadcastChannel/IndexedDB 需要同源 http 环境）
python3 -m http.server 8000
# 或
npx serve .
```

打开 `http://localhost:8000`，多开几个标签页即可验证实时同步。

## 验收测试（Node 模拟）

```bash
node test/simulate.js
```

覆盖 6 个验收场景：4 标签页并发一致、并发删除幂等、离线恢复合并、
消息乱序不丢、刷新一致、关闭标签页数据不丢。

## 设计

- **操作日志（op-log）**：所有变更（add / set-completed / delete）是追加式操作，
  带全局唯一 `opId`（`tabId-seq`）和 Lamport 时钟，按 `(lamport, tabId, seq)`
  全序重放得到清单，结果确定、与到达顺序无关。
- **IndexedDB 是事实源**：本地操作先落库再广播；启动、窗口聚焦、`online`、
  bfcache 恢复时全量重放，因此丢消息、乱序、离线期间的变更都能合并。
- **BroadcastChannel 只是加速通道**：收到操作幂等应用（重复 `opId` 直接丢弃）。
- **并发语义**：
  - 完成用 `set-completed`（携带目标值）而非"取反"，重复/乱序投递幂等；
  - 删除是墓碑终态，并发删除同一条只生效一次，不会重复也不会复活；
  - 并发添加各自独立，按全序稳定排序。

## 文件

- `sync.js` — 核心同步逻辑（浏览器/Node 共用，不依赖 DOM）
- `app.js` — IndexedDB 持久化 + BroadcastChannel + DOM 渲染
- `index.html` / `styles.css` — 页面与样式
- `test/simulate.js` — Node 验收模拟（共享 IDB + 可控消息总线）

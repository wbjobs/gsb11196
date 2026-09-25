# 同步待办清单

纯前端待办清单：添加 / 完成 / 删除，多个标签页实时同步。无构建、无依赖。

## 运行

```bash
# BroadcastChannel 需要同源上下文，请通过 http 访问（不要用 file://）
python3 -m http.server 8000
# 打开 http://localhost:8000 ，多开几个标签页同时操作
```

## 测试

```bash
node test/sync.test.cjs
```

在 Node 中模拟 4 个标签页 + 可乱序/可离线的广播总线 + 共享 IndexedDB，覆盖全部验收标准。

## 设计

- **操作日志 + LWW**：不做状态同步，只做操作同步。每个操作（add / setCompleted / delete）
  是不可变记录，带逻辑时间戳 `(ts, opId)`，全部持久化到 IndexedDB，页面状态由操作日志折叠得出。
- **收敛保证**：操作满足交换律、幂等律 ——
  - `add`：itemId 唯一，重复添加去重；
  - `setCompleted`：同一事项按 `(ts, opId)` 取最后写入，并发勾选结果确定；
  - `delete`：墓碑标记，幂等，同时删除同一条不会重复也不会复活。
  因此消息乱序、重复投递不影响最终一致性。
- **实时同步**：本地操作先写 IndexedDB 再经 BroadcastChannel 广播；
  收到操作按 opId 去重后落库并刷新视图。
- **离线恢复（反熵）**：启动、网络恢复（`online`）、页面重新可见时广播 `hello`，
  其他标签页回发完整操作日志，缺失操作自动补齐合并。
- **持久化**：IndexedDB 同源共享，刷新任意标签页或关闭全部标签页数据都不丢。

## 文件

| 文件 | 说明 |
| --- | --- |
| `sync.js` | 同步核心（操作日志、LWW 折叠、反熵协议），与 DOM/存储/广播解耦 |
| `app.js` | 浏览器胶水层：IndexedDB + BroadcastChannel + DOM 渲染 |
| `index.html` / `style.css` | 页面与样式 |
| `test/sync.test.cjs` | 验收测试（7 项，对应全部验收标准） |

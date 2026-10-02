# Schema Evolution Studio

Run `npm install`, then `npm run dev` (Express API on `:4174`, Vite on `:4173`).
Tests: `npm test`. Typecheck + production build: `npm run build`.

## 两种工作台模式

- **单对比较**：一份 v1、一份 v2 的向后/向前双向判定，反例由同一套验证器
  证明（生产者接受 ∧ 消费者拒绝）。
- **多消费方发布**：一份待发布生产者定义面对一组**有名称、各自修订号**的消费方。
  - 每个消费方独立显示「新生产者→该消费方」（准入方向）和「该消费方→新定义」
    （风险方向）两个判定及拒绝原因，不折叠成单一红绿灯。
  - 标记为**必需**的消费方才计入准入规则；非必需消费方即使拒绝也只显示风险。
  - 预览固定当时的消费方修订并返回指纹/token。切换场景或修改草稿后，旧结论会被
    标记为脱节；编组被他人改动时通过轮询也能发现。
  - 确认发布是唯一的服务端状态变更：服务端重新比对修订并从零重算所有判定，
    修订漂移 → `409 preview_stale`（附带服务端当前预览），准入失败 → `422 gate_blocked`。
    浏览器里的旧结论永远不能被直接批准。
  - 发布记录持久在服务端，固定每份消费方修订、其 schema 快照、双向判定和生产者
    定义，重开页面可复查。

### 发布相关 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/release/consumers` | 列出 / 新建消费方 |
| GET/PUT/DELETE | `/api/release/consumers/:id` | 读取 / 乐观锁更新（带 `revision`）/ 删除 |
| POST | `/api/release/preview` | 对当前编组计算预览，返回 token 与指纹 |
| POST | `/api/release/confirm` | 服务端重新固定修订并重算后确认发布 |
| GET | `/api/release/releases[/:id]` | 发布记录列表 / 单条审计详情 |

# Copilot → dsh：真实集成方案（Integration Plan）

> 依据 `~/work/deepseek-harness` 当前 master（`dsh 0.1.2-alpha.4`，monorepo）实际代码编写。
> 文档内的 `path:line` 锚点均指向该 checkout；`docs/user/...` 为该仓库内置用户文档。
> 结论一句话：**把 dsh-provider-copilot 从“自造的 LlmProvider 形状”改造成 dsh 真正的
> “LLM adapter 插件包”（cordis object plugin + `LlmAdapter` 子类 + bundle patch），
> 注册 provider route `copilot`，就能在 dsh 的模型选择器里看到 Copilot 并直接对话。**

---

## 0. 现状诊断：为什么今天“看不到 Copilot”

本仓库的 dsh 集成面（`src/provider/dshInterface.ts`、`src/commands/entry.ts::registerCopilot`、
README 里的 `dsh plugin add` 用法）是**基于一个不存在的 dsh API 写成的**：

| 假设（本仓库） | dsh 实际（deepseek-harness） |
|---|---|
| provider 是一个 `{ id, listModels, stream }` 形状的“LlmProvider”，dsh “按形状加载” | provider 是 **cordis 插件**，在 `apply(ctx, config)` 里调用 `ctx.llm.registerAdapter(['copilot'], adapter)`，adapter 必须（最好）继承 `packages/llm/llm/src/index.ts:193` 的抽象类 `LlmAdapter` |
| chunk = `{type:'text'|'reasoning'|'finish', …}` | chunk = 索引块协议 `StreamChunk`（`packages/llm/llm/src/types.ts:364-376`）：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish` |
| `registerCopilot(ctx)`，ctx 上有 `registerProvider/registerCommand/effect` | ctx 上没有任何 `registerProvider/registerCommand`；命令注册是 `ctx.commands.register(...)`（`packages/interaction/commands/src/index.ts:274`），provider 注册见上 |
| `dsh plugin … add` 装完“重启即生效” | `dsh plugin` 只是 pnpm 转发 + 维护 `dsh.profile.bundles`（`apps/cli/src/plugin.ts:120-163`）；**只有 package.json 声明了 `dsh.bundle.patch` 的依赖才会被加入 bundles 层并被加载**（`:36-45 exportsPatch`）。本仓库 package.json 没有 `dsh` 字段、没有 `cordis.patch.yml`、没有 `name/inject/apply` 插件导出 → 即便装了也只是“普通依赖”，永远不会被加载 |

两个独立问题：**(1) 包没有被任何 dsh 组合装载；(2) 即使装载了，注册/流协议也对不上。**
下面按 dsh 的真实契约给出改造方案。

---

## 1. dsh 真实扩展点速览（决定方案的骨架）

- **组合（composition）**：dsh 的 profile（如 `web`）由若干 **bundle patch 层**组成。每层是一个
  YAML patch（`docs/architecture.md:19-23`），往空根里 `insert` 若干行，例如
  `packages/bundle/base/cordis.patch.yml:107-108`：
  ```yaml
  - id: llm-pi-ai
    name: '@deepseek-ai/dsh-llm-pi-ai'
  ```
  行 = `{ id, name, config, disabled? }`；loader 对 `name` 做动态 import（profile
  `node_modules` → 安装目录 fallback，`packages/boot/app-boot/src/profile.ts:15-22`），再按
  cordis 插件契约启动（对象导出 `{ name, inject, apply }`，`vendor/loader/src/config/entry.ts:277-302`）。
- **LLM 服务**：`ctx.llm`（`LlmRuntime`，`packages/llm/llm/src/index.ts:326`）：
  - `registerAdapter(providers: string[], adapter: LlmAdapter)` → 路由注册（`:380-409`；重复路由抛 `DUPLICATE_ADAPTER`）
  - `registerConfigurableProviders(entries)` → 可配置 provider 目录（`:474-527`），供 Models 页展示
  - `listProviders()/listModels(provider)/resolveModelInfo(...)` → 模型目录数据源（`:461-464, 674-701, 712`）
  - 每次注册/换路由发 `llm/adapters-updated`（`:447-455`）——**web 端模型选择器订阅它并自动刷新**
    （`packages/client/ui-model-selection/src/client/service.ts:57`；浏览器目录由
    `packages/api/session-controller/src/catalog.ts:16-67 buildModelCatalog` 提供，
    `@Remote('modelCatalog')` 在 `src/index.ts:253-256`）。
- **adapter 契约**：实现（多数可选）`providerInfo / listModels / resolveModel / prepareCall / stream`，
  至少 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`。流 chunk 被
  `BlockAssembler`（`assembler.ts`）组装成 assistant 消息。**纯文本 adapter 完全受支持**：
  agent loop 只在有 tool schema 时才发 tools（`packages/core/agent-loop/src/agent.ts:501-502`），
  assistant 消息没有 tool-call 块就正常结束回合（`:430-431`）。声明 `inputModalities: ['text']`
  会让运行时在派发前把用户图片自动投影成文本（`packages/llm/llm/src/index.ts:996-1002`）。
- **每个 provider HTTP 请求必须带 attribution**：`attributionHeaders()`（目前是一个
  `user-agent: <product>/<version> (+url)`，`packages/llm/llm/src/attribution.ts:64-68`），
  adapter 文档明示此义务（`packages/llm/llm/src/index.ts:187-192`），需 wire 级测试证明
  （参考 `packages/llm/llm-deepseek/src/adapter.ts:535`）。
- **官方编写文档（照做即可）**：
  - `docs/user/develop/practice/llm-adapter.md` —— 最小 LlmAdapter + chunk 协议 + 注册 + 开发期
    `--patch` overlay 加载
  - `docs/user/develop/basic/publish.md` —— 第三方 bundle 打包与 `dsh plugin add` 安装
  - `docs/user/guide/providers.md` —— Settings → Models 页用户视角

---

## 2. 目标形态

改造后本仓库是一个 **dsh 插件包**（npm bundle），对外（构建产物）导出：

```ts
export const name = 'llm-copilot'          // 插件名（与 patch 行 id 一致；不是包名）
export const inject = ['llm']              // 依赖 llm 服务（同 llm-pi-ai, index.ts:90-91）
export function apply(ctx: Context, config: Config): void
```

`apply` 内部（参考 `packages/llm/llm-deepseek/src/index.ts:405-497` 的成熟骨架）：

1. 组装 `CopilotAdapter extends LlmAdapter`（复用本仓库 AuthManager/CopilotClient 的能力）。
2. `ctx.llm.registerConfigurableProviders([{ provider: 'copilot', displayName: 'Copilot (GitHub)', settingsNs: 'llm-copilot', settingsPath: [] }])`。
3. `ctx.llm.registerAdapter(['copilot'], adapter)`（返回 handle 可原子 `replace`）。
4. `ctx.inject(['settings'], …)` 里 `settings.installSection(ctx, 'llm-copilot', Config, config, { setSource, onChange })`，
   让设置变更无需重启即生效（动态 options 通过 `options()` thunk 每请求重读，deepseek 同款）。
5. 可选接缝：`ctx.inject(['authorization'], …)` 注册登录流（见 §6）；`ctx.get('credentials')` 解析凭据。

装载方式（二选一，均可让 Copilot 出现在模型选择器）：

- **方式 A（推荐，不改 dsh 源码）：npm bundle**
  - `package.json` 增加 `dsh: { bundle: { patch: 'cordis.patch.yml' } }`（bundle 判定，`profile.ts:50-53`），
    `exports` 增加 `"./cordis.patch.yml"` 子路径导出（参考 `packages/bundle/base/package.json`）。
  - 包内 `cordis.patch.yml`：
    ```yaml
    - insert:
        - id: llm-copilot
          name: dsh-provider-copilot
          # config: { ... }  # apply(ctx, config) 的默认配置
    ```
  - 安装：`dsh plugin --profile <profile> add <npm | github:… | /本地路径>`，重启 dsh
    （reconcile 会自动把它加入该 profile 的 bundles 层，`apps/cli/src/plugin.ts:59-91`）。
- **方式 B（开发期/无需打包）：profile patch 行或 `--patch` overlay**
  - 在 profile 的 `cordis.patch.yml` 或启动 `--patch` 里加一行（`docs/user/develop/practice/llm-adapter.md:126-143`）：
    ```yaml
    - id: llm-copilot
      name: './path/to/dsh-provider-copilot/src/plugin.ts'   # 开发期可直接指 TS 入口
    ```
    并把包加入 profile 依赖（pnpm）。适合在 dsh checkout 里迭代验证。

---

## 3. 分阶段实施

### Phase 1 —— 协议对齐：写一个真正的 `LlmAdapter`（核心工作）

在 `src/provider/` 新增（或改造）：

- `class CopilotAdapter extends LlmAdapter`（依赖 `@deepseek-ai/dsh-llm`；peerDependency 而非 dependency，
  与宿主共享同一实例，见 §7）：
  - `providerInfo(provider)` → `{ id: 'copilot', name: 'Copilot (GitHub)' }`（模型选择器分组名）。
  - `listModels(provider)` → 现有 `whitelist ∩ remote` 逻辑映射成 `LlmModelInfo`
    （`types.ts:285-296`：**必须带 `provider:'copilot'`、`name`**；`inputModalities:['text']`）。
    **无凭据时的策略**：别抛错，返回静态 whitelist（DeepSeek 也是无 key 就列目录、请求时才报
    `MISSING_CREDENTIAL`）；有会话时做 whitelist∩remote。
  - `resolveModel(provider, model, signal?)` → 从 whitelist 条目返回 `{ context:{contextWindow},
    defaultMaxTokens, inputModalities:['text'] }`（可留 `reasoning` 不声明 = 无可调 reasoning effort，
    `index.ts:846-880` 会据此拒绝显式 effort）。
  - `stream(options: GenerateOptions)` —— **新 chunk 翻译**：把 `CopilotClient` 的 OpenAI 兼容 SSE
    逐条翻译成 StreamChunk，照抄/参考 `packages/llm/llm-deepseek/src/translate.ts:96-195` 的“每类块一个
    状态、index 递增、`block-end`/`usage`/`finish` 收到 `[DONE]` 后再发”的结构：
    - `delta.content` → 同一 text 块的 `block-start('text')` + `text-delta`
    - `delta.reasoning_content` → 同一 reasoning 块的 `block-start('reasoning')` + `reasoning-delta`
      （前端按块渲染为“思考”折叠区，`packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`）
    - `finish_reason: stop|length|tool_calls|其它` → `finish: {kind:'stop'|'max-tokens'|'tool-calls'|error…}`
    - `usage` → `{ type:'usage', usage: { inputTokens, outputTokens, … } }`（`usage` 必须在 `finish` 前）
  - 消息映射：`GenerateOptions.system` → 请求 system slot；`messages`（role `system|user|assistant`，
    content 是 `ContentBlock[]`）→ 取文本拼 wire messages；**绝不把 `options.tools` 转发给 Copilot 端点**
    （无强制校验，纯文本回复 = 正常回合结束；若转发反而可能被端点拒收）。
  - 全程遵守 `options.signal`；HTTP 请求 merge `attributionHeaders(identity)`。
- 错误归一：把现有 `ClientError.code` 翻译成 `LlmError(code,…)` 词表：401/403→`AUTH`、429→`RATE_LIMIT`
  （带 `providerRetryAfterMs`）、4xx→`INVALID_REQUEST`/`HTTP_xxx`、5xx→`SERVER`、无凭据→
  `MISSING_CREDENTIAL`、超时→沿用现有 timeout code（参考 `llm-deepseek/src/adapter.ts:332-344`；
  LlmRuntime 会把 stream 内 throw 归一成 error/aborted finish，`index.ts:1069-1077`）。
- `attribution` 与 Copilot UA 的冲突单独处理（见 §7 风险 2）。

> 现有 `CopilotProvider`（旧的 LlmProvider）可以保留为“BYOK/程序化”薄壳，但 dsh 集成路径只走
> `CopilotAdapter`。

### Phase 2 —— 插件壳 + 可装载（让包被 dsh 加载）

- 新增插件入口（例如 `src/plugin.ts`），导出 `name/inject/apply`（§2），内部组合现有
  AuthManager/CopilotClient/CopilotAdapter/JSONL logger。
- `package.json`：`type: module`（已有）、声明 `dsh.bundle.patch`、`exports` 加
  `"./cordis.patch.yml"`、把 `@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`（及用到时
  `@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-authorization`、
  `@deepseek-ai/dsh-commands`）列为 **peerDependencies**。
- 附 `cordis.patch.yml`（§2 方式 A 内容）。
- 修正 README：安装段改为真实的 `dsh plugin --profile <profile> add <包>` + 重启；“Usage inside
  dsh”改为真实命令（见 §6）；删除“ctx.registerProvider”等虚构 API 的描述。
- 验证：在任一 profile 装载后，`listProviders()` 应含 `copilot`，模型选择器出现 Copilot 分组
  （自动刷新，无需重启前端）。

### Phase 3 —— 设置、凭据与 Models 页

- `registerConfigurableProviders` 让 “Copilot (GitHub)” 作为可配置 provider 出现在
  Settings → Models（页面数据 = `listProviders() ∪ listConfigurableProviders()` +
  settings mirror + `credentials.describe`，`packages/client/ui-settings-models/src/client/store.ts:41-66,178-241`）。
- 设置段（schema 建议字段）：`tokenSource`（bearer/github/device-flow）、`apiKeyEnv`、`whitelist`、
  `baseURL` 覆盖（默认取 `endpoints.api`）、超时、`disableLog`。写 `settings.yaml` 的
  `llm-copilot:` 段，改后 `onChange` → `registration.replace([…])` 即时生效。
- 凭据解析顺序（对齐 `AuthManager` 现有优先级 + dsh 接缝）：
  1. `ctx.credentials` 记录（scope `llm-copilot`，`credentialKey('llm-copilot','copilot')`）——
     grant 存 `ghu_*` GitHub 授权结果（opaque JSON，参考 pi-ai `src/auth.ts` 的 grant 读写），
     或 api-key 存原始 Copilot bearer；
  2. 环境：`launchEnvironmentOf(ctx)`（deepseek 同款，`llm-deepseek/src/index.ts:430-451`）读
     `COPILOT_TOKEN` / `COPILOT_GITHUB_TOKEN` 及既有 opt-in 变量；
  3. （兼容兜底）现有 `~/.config/dsh/copilot/` 文件缓存。
  - 无 credentials 服务时写操作抛 `NO_CREDENTIAL_STORE`（pi-ai `auth.ts` 同款）；无任何凭据时请求抛
    `MISSING_CREDENTIAL` 并指路（deepseek 文案模式）。
- 模型发现 `registerModelDiscovery` 对 Copilot 不必需（模型来自 whitelist∩remote，不是用户自定义端点），
  可不做。

### Phase 4 —— 登录 UX（把 `/copilot login` 变成真实能力）

dsh 有两套真实接缝，方案里**两个都注册，实现上共享同一个 device-flow runner**：

1. **命令**：`ctx.commands.register({ name:'copilot', description, handler })`
   （`packages/interaction/commands/src/index.ts:62-70,254-279`；web 端 `/` 输入框解析并执行，
   `commands/list` + `commands/execute`）。子命令 `login|logout|status` 沿用现有
   `src/commands/commands.ts` 逻辑：
   - `login`：开始 GitHub Device Flow，成功后写 credential 记录；
     因 `CommandResult` 是“单次成功文本”（`success.text`，`types.ts:28-36`），返回
     `open: <uri>\ncode: <code>` 即完成命令，随后 `/copilot status` 确认结果（device flow 在后台
     fiber 轮询，绑定 ctx effect 生命周期，防泄漏）。
   - `status` / `logout`：与现有实现一致；logout 同时删 credential 记录 + 取消后台刷新。
2. **授权流（native，长期目标）**：照 pi-ai `registerPiAiFlows`（`packages/llm/llm-pi-ai/src/login.ts:120-161`）
   调 `ctx.authorization.registerFlow({ key, label, methods:[{id:'oauth',label:'GitHub Device Flow'}],
   run(session){ …session.notify({url, code})… } })`。**已知 gap**：当前 dsh 没有把
   `authorization/*` 暴露给 Web 的 RPC 通道，即 Models 页暂没有现成“Sign in”按钮可触发 flow
   （调研结论：浏览器 RPC fixture 表中无 authorization 通道）。因此 Phase 4 MVP = 命令路线；
   flow 路线在宿主补 Web 触发面后接入（可在本仓库后续以 client 包 `ui-*` 形式贡献）。

### Phase 5 —— 会话可用性（无需工具调用，MVP 就能跑）

- 按 §1：不转发 tools、纯文本 finish 正常收尾 → dsh 会话里 Copilot 开箱即用；reasoning 块前端已有
  独立渲染。
- `purpose`/`sessionId` 可不处理（适配器可选）；若要支持 dsh 的自动会话标题（title-llm 等辅助调用）
  可映射到请求元数据，非必需。
- 后续可选：Copilot 端点支持 `tools` 时再实现 `tool-call-delta` 映射（`translate.ts:162-180` 已有现成
  模式），届时摘掉“no tools”非目标。

### Phase 6 —— 测试与验收

- 移植现有 111 个单测：把“旧 chunk 形状”断言改成 StreamChunk 断言；AuthManager/CopilotClient/logger 基本不动。
- 新增 wire 级测试：**证明每个 HTTP 请求带 attributionHeaders**（dsh 硬性要求，`docs/subsystems/llm-streaming.md:288`）。
- 新增“宿主契约”测试：用 dsh 的 test-support（`packages/test-support/llm-replay`）或最小 harness
  （`ctx.llm.registerAdapter(['copilot'], adapter)` 后跑 BlockAssembler）验证 block-start/delta/end/usage/finish 序列。
- 端到端手测清单：
  1. `dsh plugin --profile <GUI 所用 profile> add <本包>` → 重启 dsh；
  2. `/copilot login` → 浏览器授权 → `/copilot status` 显示 ok + 模型数；
  3. 模型选择器出现 “Copilot (GitHub)” 分组及 whitelist 模型；
  4. 对话流式输出正常；o 系模型推理文本显示为“思考”折叠区；
  5. 断开/过期 token → 请求报可读错误；`/copilot logout` 后列表消失或请求报 `MISSING_CREDENTIAL`。

---

## 4. 关键 dsh 参考文件清单

| 目的 | 文件 |
|---|---|
| adapter 契约/流协议/错误 | `packages/llm/llm/src/types.ts`、`assembler.ts`、`adapter-failure.ts`、`error.ts`、`attribution.ts` |
| adapter 插件骨架 | `packages/llm/llm-deepseek/src/index.ts` + `adapter.ts` + `translate.ts`；`packages/llm/llm-pi-ai/src/index.ts` |
| 凭据/授权接缝 | `packages/credentials/*`、`packages/llm/llm-pi-ai/src/auth.ts`、`login.ts` |
| 装载/bundle | `packages/boot/app-boot/src/profile.ts`、`apps/cli/src/plugin.ts`、`packages/bundle/base/cordis.patch.yml` |
| 选择器/Models 页 | `packages/api/session-controller/src/catalog.ts`、`packages/client/ui-model-selection/src/client/*`、`packages/client/ui-settings-models/src/client/*` |
| 命令 | `packages/interaction/commands/src/index.ts` + `types.ts` |
| 官方文档 | `docs/user/develop/practice/llm-adapter.md`、`docs/user/develop/basic/publish.md`、`docs/user/guide/providers.md` |

---

## 5. 风险与注意事项

1. **接口漂移**：dsh 是 `0.1.2-alpha`，`LlmAdapter`/`StreamChunk`/装载协议仍可能演进。方案锁定在
   当前 master；升级 dsh 版本时按 §4 文件清单做 diff 回归。声明 peerDependencies 时给兼容区间并在 CI 里
   用目标 dsh 版本做契约测试。
2. **attribution vs Copilot UA**：attributionHeaders 生成的 UA 是 `deepseek-harness/<ver> (+url)`，
   而 `api.github.com` 反爬要求 UA 以 `GitHubCopilot` 开头（403 表现形似鉴权错）。Copilot LLM 端点
   （`endpoints.api`，如 `*.githubcopilot.com`）是否强制 UA 需实测；建议给
   `attributionHeaders({ product:'GitHubCopilot-dsh', … })` 之类的白标 identity 或保留
   `GitHubCopilot-*` UA 并附带 identity，用 wire 测试锁定最终组合。
3. **凭据短寿命**：Copilot bearer ~30 分钟、`ghu_*` 更长但也会过期 → 后台刷新/到期重登的生命周期要绑
   ctx effect，卸载/HMR 时取消（registerAdapter 自身经 ctx.effect 注册，插件卸载会自动清路由；额外的
   后台轮询需自行 dispose）。
4. **duplicate route**：若用户同时用 `llm-pi-ai` 声明了 `copilot` route，注册会抛
   `DUPLICATE_ADAPTER`（`index.ts:421-423`）→ 文档写明二选一。
5. **picker 可见性语义**：`buildModelCatalog` 会过滤空模型组（`catalog.ts:63-64`）——所以“未登录就
   想看到 Copilot 分组”要靠 §3 Phase 1 的静态 whitelist 策略，而不是空列表。
6. **合规**：README 已有的 “非公开 API” 声明保留并加粗（token exchange 无 SLA；UA/client_id 随时可能
   收紧）；绝不在日志/JSONL 里记录 token/body/header（现有 allowlist 已保证）。

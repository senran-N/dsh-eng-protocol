# dsh-eng-protocol

DeepSeek Harness 的工程协议插件：**让 agent 在长任务里不丢掉它该守的规矩。** 通用工程纪律（授权边界、改动范围、验证、不削弱测试……）和已加载 skill 里的硬性要求，被整理成一张张可判定的决策卡；证据出现时只判断被触发的那几张，再沿宿主自己的通道在“还来得及改变动作”的时刻送达：常驻上下文、请求前、动作前、动作后、交付前。每次决策都写入轨迹和统计页，你能看到“什么时候提醒了、用了哪张卡、依据是原文哪一句”，也能用影子模式衡量“提醒到底有没有用”。

它借鉴了 Pi 版 `eng-protocol` 的问题意识，但按 DSH 的 Cordis 事件模型重写：不轮询每一步，不把全部规则塞进系统提示，不替换主模型，也不替代宿主自己的 skill 加载。

![Eng Protocol 深色面板](docs/dashboard-dark.png)

![Eng Protocol 浅色面板](docs/dashboard-light.png)

## 它做什么

1. **规则来源**：16 张内置通用工程卡负责跨领域的失败模式；领域义务来自 agent 实际加载的 skill。
2. **skill 用到才编译**：读取宿主的 skill 目录不需要任何模型调用——每个 skill 的入口卡直接由宿主给出的 `description`、`whenToUse` 和调用策略生成。只有当 agent 真正加载了某个 skill（模型调用 `skill` 工具成功，或用户 `/名称` 显式调用），才用编译模型把它的正文整理成章节卡：
   - 原文支持多少条独立义务就生成多少张（没有卡数上限），每张带触发事件、完成证据；
   - **每条义务必须附一句逐字摘自正文的原文**，插件会在正文里核对这句话，行号由它的真实位置算出；找不到的卡只作参考提醒，永远不能拦截，也不进常驻上下文；
   - 可选的文件 / 命令范围（如 `**/*.sql`、`alembic`），只有涉及匹配的文件或命令时才拿出来判断；
   - 可选的“动手前检查”：原文明确要求“做 X 之前先 Y”且原文核对通过的义务，可以在 X 之前软拦截一次；
   - 关系边：`requires` / `blocks` / `covers` / `arbitrates` / `fuses`，加上系统生成的 `contains` 归属边。
3. **编译结果按内容共享**：编译结果以“编译模型路由 + 编译选项 + skill 正文与元数据”为键存成一个个独立文件，所有项目、会话和子 agent 共用。用户级 skill 在任何项目里只编译一次；同时需要同一个 skill 的两个 agent 共享同一次模型调用；一个 agent 看到的 skill 列表不同，也删不掉别人的编译结果。
4. **skill 作用域**：skill 在 agent 加载它的那一刻进入作用域；之后每个新回合都会复核它是否仍适用，被判为不适用才退出。还没加载的 skill 只有在请求点名了它、或描述与请求和改动文件明显相关时才拿去判断（目录不大时全部判断）；判为适用时，提醒的是“先用 `skill` 工具加载它”，而不是塞一段改写过的要点。`modelInvocable: false` 的 skill 只能由用户显式调用。运行图和作用域按 agent 隔离，同一目录下不同 agent 的可见 skill 不会串用。
5. **本地事件检测**：从 DSH 的 `session/event` 流识别 `turn`、`read`、`edit`、`first_edit`、`test_edit`、`check_start`、`checked`、`failed`、`stuck`、`dependency`、`untrusted`、`skill`、`settle`、`heartbeat`、`risky`、`research`、`delegate`。
6. **决策模型**：把被触发的卡交给辅助模型判断 `needed / addressing / satisfied / inapplicable / unknown`，判官看得到每张 skill 卡的原文摘录。所有有把握判为 `needed` 的卡都会送达（按 critical / 优先级排序、去重、冷却）。规则多时分批并行检查；新回合的规则多到一轮判不完时，先判各 skill 的入口卡，只展开仍然相关的 skill 的规则。
7. **五个送达时机**，各用宿主的原生通道：
   - **常驻**（`ctx.systemPrompt.context`）：已加载 skill 的硬性要求（逐字原文，动手前检查排在前面）。宿主只在内容变化或被上下文压缩移除后才重新放入，所以长会话压缩掉 skill 原文之后，这些要求仍在；
   - **请求前**（`agent/pre-step`）：新回合的通用检查和 skill 路由，以及对上一步工具结果（失败、检查完成等）的判断；
   - **动作前**（`tools/pre-execute`）：可拦截的卡（内置关键卡、skill 的动手前检查）软拦截一次，同一回合内同目标重试直接放行；
   - **动作后**（`tools/post-execute`）：拦不住这次调用的判断与工具并行执行，结论通过 `additionalContexts` 挂在这次工具结果后面，和它所说的那个动作一起送到模型面前；
   - **交付前**（`agent/turn-stopping`）：再判断一次，必要时 `agent.inject()` 续跑一轮。
8. **可见性**：提醒消息的 `source.kind` 是 `eng-protocol`，`form` 是 `notice`。DSH 的 Chat/Trajectory 会把它显示为带 `eng-protocol` 标签的 context 行，正文包含 `[card: ...]`、触发事件和原文摘录。
9. **面板与标签页**：`/eng-protocol` 显示当前项目的卡总数、skill 卡/内置卡、skill 准备情况、注入次数、软拦截次数、决策耗时、提醒后处理率与影子基线、拓扑图、卡片列表、触发轨迹。客户端半边还会注册一个 `conversation.view` 标签页 **Eng Protocol**，排在 Chat 和 Trajectory 旁边，用同源 iframe 嵌入同一块面板。

## 安装（当前 Desktop profile）

插件是纯 ESM JavaScript，没有第三方依赖，不需要构建。把下面这一行加到 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾：

```yaml
- insert:
    - id: eng-protocol
      name: 'D:/Myproject/dp-dp/dsh-eng-protocol/index.js'
      config:
        dashboard:
          path: /eng-protocol
```

然后重启 DSH，或让 profile 的 HMR 重新组合。面板在会话的 **Eng Protocol** 标签页里（排在 Chat 和 Trajectory 旁边），按当前会话显示。也可以直接打开 DSH Web 地址下的 `/eng-protocol?sessionId=…`（例如 `http://127.0.0.1:27480/eng-protocol?sessionId=…`），或用 `scope=project&cwd=…` 看整个项目的汇总。

> 客户端标签页由 `client.js` 在启动时组合进浏览器图；补齐客户端半边后需要完整重启一次 DSH，标签才会出现。

> 路径行按绝对路径或相对 patch 文件的路径解析；插件自身不导入 `@deepseek-ai/*` 包，因此不需要在 profile 里安装依赖。开发中可在 `index.js` 后加 `?v=N` 让 Cordis 重新导入模块；正常重启后不需要查询串。

也可以不修改 profile，用一次性 overlay 启动：

```powershell
dsh web --patch D:/Myproject/dp-dp/dsh-eng-protocol/cordis.patch.yml
```

## 配置

配置有三层，后者覆盖前者：内置默认值 ← `$DSH_HOME/eng-protocol.json`（默认 `~/.dsh/eng-protocol.json`）← `cordis.patch.yml` 里的 `config`。完整示例见 [`config.example.json`](config.example.json)。

项目级 `.dsh/eng-protocol.json` 只能设置 `skills.include` / `skills.exclude`，用来收窄这个项目使用哪些 skill；其他字段一律忽略，并在面板的“配置”区列出。这样一个克隆来的仓库既关不掉防护，也改不了模型路由。

```json
{
  "enabled": true,
  "shadow": false,
  "minConfidence": 0.6,
  "cooldownSteps": 3,
  "heartbeatSteps": 8,
  "builtinCards": true,
  "skills": { "enabled": true, "include": [], "exclude": [], "standing": true },
  "decision": {
    "provider": "deepseek-account",
    "model": "deepseek-flash",
    "temperature": 0.1,
    "reasoningEffort": "off",
    "timeoutMs": 15000,
    "cacheTtlMs": 15000
  },
  "compiler": {
    "provider": "deepseek-account",
    "model": "deepseek-flash",
    "temperature": 0.1,
    "systemAsUser": true,
    "timeoutMs": 180000
  },
  "enforcement": {
    "enabled": true,
    "cards": ["halt", "scope", "anti_reward_hacking", "no_cheat", "trust_boundary", "refuted_premise"],
    "skillCheckpoints": true
  },
  "dashboard": { "enabled": true, "path": "/eng-protocol" }
}
```

### 运行时如何调节

所有被触发的规则都会检查，所有需要的提醒都会送达（按关键程度排序，去重、冷却），用到的 skill 都完整编译。调用模型的节奏由 `lib/adaptive.js` 按每个模型路由的实际表现调节：

- **并发**：成功一轮加 1，遇到限流或过载减半，并遵守上游的 Retry-After。
- **时限**：每一轮检查的等待时间约为观测延迟 p95 × 2 + 1.5 秒；`timeoutMs` 只是每一轮的硬上限，样本不足时使用它。时限到了，已经答完的批照常生效，只有没答完的那几条记为“没在时限内检查完”。
- **批大小**：规则多时分批并行检查。只有一批真正装满并且完整答完，批才会慢慢变大；回答被截断就把这一批对半拆开，一次调用跑了超过一半时限还没答完，后续批次也会变小（排队等出来的超时不算）。有关系边相连的规则放在同一批，判官能对照着看。
- **逐层展开**：新回合要判的卡多到一轮并行装不下时，先判各 skill 的入口卡，再只展开仍然相关的 skill 的规则；判为与当前任务无关的 skill，它的规则不再送去判断，面板上标为“这个 skill 与当前任务无关”。一轮装得下时仍然一次判完，这样最快。这一步刚被调用的 skill 不用先判入口卡。

编译分段不随运行状况变化：正文按标题 / 行边界切成约 24k 字符的段，同一份正文永远得到同样的分段和同样的检查点；某段输出被截断时才把它对半拆开，并记住“这段要拆”，下次不会再整段重发。

旧版本配置文件里已不再使用的字段会被静默忽略（只写一条 debug 日志），在面板“设置”里保存一次时会顺手从文件中去掉。

- `decision.provider` / `model` 省略时跟随主 agent 的模型；建议显式指定一个便宜、稳定的辅助模型。
- `compiler` 省略时复用 `decision` 的路由。编译结果按“编译器版本 + 模型路由 + 编译选项（temperature / reasoningEffort / systemAsUser）+ skill 正文与元数据”寻址；超时等不影响输出的参数不会让结果失效，换编译模型则会让用到的 skill 重新编译。来源显示为 `#body:Lx-Ly`，表示去掉 frontmatter 后的正文行号。外链只记录位置，不自动加载内容。
- `skills.include` / `exclude` 用精确 skill 名过滤。
- `skills.standing: false` 关闭常驻上下文：已加载 skill 的要求只在被触发时作为提醒送达。
- `shadow: true` 时照常判断并记录每次决策，但不注入提醒、不拦截、不续跑、不写常驻上下文，用来对比效果（见下文“评估效果”）。
- `enforcement.cards` 列出的卡在编辑/命令执行前可以软拦截一次；`enforcement.skillCheckpoints` 决定 skill 的“动手前检查”是否也能拦截（只限原文核对通过的义务）。两者都关掉即只提醒不拦截，但交付前续跑仍然有效。`enforcement.enabled: false` 同时关闭软拦截和交付前续跑。
- `cooldownSteps` 按回合内的真实步数计：一张卡送达后，要再过这么多步才会再次提醒；同一步里（例如并行的几个工具调用）同一张卡只送达一次。新用户回合重置。`halt`、`trust_boundary`、`anti_reward_hacking` 等 critical 卡不受冷却限制。
- `heartbeatSteps` 是兜底判断的间隔：一个回合每走这么多步触发一次 `heartbeat`；设为 `0` 关闭。
- `debug: true` 额外注册 `/eng-protocol/api/debug`，用于确认客户端半边是否被组合进浏览器图。

### 思考强度按模型适配

DSH 会严格按模型声明的档位校验思考强度，不支持就拒绝请求。插件在发请求时通过 `prepareCall` 的 `configure` 回调拿到这个模型的真实能力：所选档位可用就用；不可用就改用最接近的一档（`off` 对应最轻的一档）；模型没有思考强度时就不传。实际用了哪一档会显示在“设置”里。

### skill 编译：按需、共享、可续传

- **用到才编译**：读目录只读定义、不调模型；agent 加载某个 skill 时才编译它。已经编译过同一份正文的（哪怕在别的项目、别的会话），直接复用。面板的 Skills 页把还没用到的 skill 标为“用到时再准备”，想提前看规则可以点“现在准备”。
- **按段检查点**：每个编译完的分段立即存成独立文件，以“路由 + 编译选项 + skill 元数据 + 段位置 + 段正文”为身份。编译被取消、进程重启、某段失败，下次都从已完成的段继续；只改了 skill 末尾时，也只重编改动的那一段。
- **自动重试**：超时、限流（429）、过载（503/529）、5xx、网络错误、模型输出不是合法 JSON，都会指数退避重试（最多 4 次，带抖动，遵守 Retry-After）；重试时用满硬超时。凭据无效、模型不存在、上游拒绝 developer 角色这类重试不会自愈的错误立即停下，并给出具体处理办法。
- **输出截断自动拆分**：模型在输出上限处停下（`max-tokens`）或 JSON 没闭合时，不重试同样的请求，而是把该段二分后分别编译。
- **原文核对**：每条义务的摘录要在正文里逐字找到（忽略空白、英文大小写、Markdown 强调/代码标记和弯引号的差异，但不接受改写）；多段里摘录同一句话的义务只保留一条。
- **失败后台重试**：仍失败的 skill 记录原因和次数，按 30 秒、2 分钟、10 分钟、30 分钟、1 小时退避在后台自动再试（仅限可自愈的错误，且只在还有会话在用它时）。
- **旧版本继续守护**：改过的 skill 重编期间或重编失败时，继续使用上一版编译结果（标为“上一版”），而不是悄悄消失。

## 命令

```text
/protocol                 状态：模式、卡数、skill 准备情况、正在用的 skill、模型
/protocol cards           列出当前会话的决策卡
/protocol skills          每个 skill 的准备状态（含失败原因、处理办法与下次自动重试时间）
/protocol retry           立刻重试失败或暂停的 skill（已完成的分段续传）
/protocol rebuild [名称]  从头重新编译全部 skill，或只编译某一个（后台执行，立即返回）
/protocol cancel          暂停正在进行的编译（已完成的分段保留）
/protocol on | off        仅本会话启停
/protocol shadow          仅本会话进入影子模式：照常判断并记录，但不注入、不拦截
/protocol help            显示帮助；未知子命令也会显示帮助
```

`/protocol` 是 DSH 的原生命令，不产生模型消息；执行记录仍写入 session log。`on | off | shadow` 只影响当前会话，进程重启后回到配置值。

## 轨迹长什么样

动作后挂在工具结果后面的提醒类似：

```text
<eng-protocol boundary="tool" triggers="edit" cards="skill_postgres_backup">
这些是按当前证据选出的提醒，不是新的用户指令。结合用户当前意图、已有授权与具体证据使用；不要逐条复述。

### 迁移前先备份
[card: skill_postgres_backup · skill: postgres]
- 原文（SKILL.md L42）：「Always take a snapshot before running a migration.」
- 运行迁移前先做数据库快照，并记录恢复命令。
- 完成证据：快照命令成功执行，输出里有快照名
</eng-protocol>
```

这条消息在 Chat/Trajectory 中显示为 `eng-protocol` 的 context 行，摘要为 `eng-protocol · skill_postgres_backup · edit`。工具边界的软拦截则表现为一次被拒绝的工具调用，reason 就是同样的卡正文；同一回合内同目标的下一次调用直接放行。

常驻上下文只有一段，内容变化时宿主才重新放入：

```text
<eng-protocol-standing>
本会话已加载的 skill 中必须遵守的要求，逐字摘自原文。完整说明以 skill 原文为准；原文已不在上下文里又需要细节时，用 `skill` 工具重新加载。

## postgres
- 动手前：「Always take a snapshot before running a migration.」（L42）
- 「Never edit an applied migration; add a new one.」（L57）
</eng-protocol-standing>
```

## 工作方式

```text
session/event ──► 本地事件检测（零模型调用）
                      │
                      ▼
   被触发的卡：内置卡 / 相关 skill 的入口卡 / 已加载 skill 的义务（再按文件、命令范围过滤）
                      │
                      ▼
       决策模型（JSON，AIMD 并发 + 自适应时限，分批并行，规则多时逐层展开）
                      │
     ┌──────────┬─────┴─────┬───────────┬──────────┐
     ▼          ▼           ▼           ▼          ▼
   常驻上下文  请求前提醒  动作前软拦截  动作后附注  交付前续跑
  (无需判官)
                      │
                      ▼
             decision JSONL + 面板
```

设计要点：

- **事件只决定“问哪些卡”**，不推断违规；没有订阅者的事件不调用模型。skill 义务还要过文件 / 命令范围这一道本地筛选，改 `.ts` 不会去问只管 `.sql` 的规则。
- **加载即作用域**：skill 进入作用域的唯一途径是 agent 真的拿到了它的原文（加载或用户调用），判官不会凭猜测把一个 skill 拉进来；判官能做的是提醒“该加载它了”，以及在新回合判断已加载的 skill 是否还适用。
- **依据可追溯**：skill 卡的提醒、常驻上下文和拦截理由都带原文摘录与行号；核对不过的卡明确标为“编译模型的概括”，只作参考。
- **拓扑参与判断**：判官能看到规则正文、原文摘录、不适用边界、完成证据与关系。`requires` / `blocks` 的前置卡会在同一证据快照中补齐；前置判断不可靠时不放行后续提醒。循环、跨 skill 和指向内置卡的前置依赖会被拒绝。`covers` 仅在覆盖卡真正入选时生效，不能让普通领域卡压掉 critical 卡；`contains` 表示归属，规则多时沿它逐层展开（入口卡判为无关，下面的规则就不再判断）；其他关系边相连的规则分在同一批；`arbitrates` / `fuses` 作为判官参考。
- **本地只认事实**：工具名、参数、文件路径（包括补丁正文里的路径）、退出状态、重复失败、可疑输出文本；语义判断交给决策模型。
- **提醒是上下文，不是新指令**：来源是 `eng-protocol`，模型被明确告知结合用户意图与已有授权使用。
- **关键安全卡有本地下限**：破坏性或对外的命令（`rm -r`、`Remove-Item -Recurse`、`del /s`、`git push`、`git reset --hard`、发布、`kubectl apply`、带数据的 `curl` 等，覆盖 POSIX、PowerShell 和 cmd 写法），以及最近一次检查失败后改写测试文件，会让 `halt` / `anti_reward_hacking` 以 `needed` 作为下限。判官只有在有把握（置信度 ≥ 0.8）判为 `satisfied` / `inapplicable` 时才能放行，比如用户明确要求了这次推送；判官不可用时下限照样生效。`git commit` 这类可撤销但涉及授权的命令只交给判官判断，没有本地下限。
- **软拦截只给一次重试**：同一回合内同目标下一次调用直接放行；修改命令或目标集合视为新目标；新的用户回合重新计算。
- **拦不住的判断不阻塞工具**：只有候选里包含可拦截的卡时，工具执行才会等待检查结果；其余检查与工具并行，结论在工具返回后挂到它的结果上（嵌套在 `run_code` 里的子调用则在下一步送达），新的用户回合会取消上一回合还没完成的检查。
- **投递前去旧、去重**：延迟提醒与当前提醒合并，每张卡只送达一次，critical 卡在前；新证据已满足的义务、失效的 skill 卡和重复卡不再投递。未实际投递的选中结果不会计入注入次数或启动冷却。
- **交付前先读最新证据**：消费最终助手回复和工具结果后再判断；检查记录携带启动时的编辑版本，避免把修改之前的绿灯当作最新修改的验证。每个宿主回合最多续跑一次。
- **判官失败时只保留本地下限**：决策模型不可用时记录失败，除上面两类本地事实外不伪造提醒；下一个有事件的步骤再试。
- **会话互相隔离**：模式开关、冷却、软拦截记录、运行图和 skill 作用域都按会话 / agent 维护；只有编译结果按内容共享。
- **模型可见即已记录**：提醒走 `agent/pre-step` / `additionalContexts` / `agent.inject` 的持久消息通道，常驻上下文走宿主的运行时上下文快照，轨迹和回放都能看到。

## 内置卡

16 张通用工程卡，覆盖：授权边界、任务范围、真实意图、假设核验、被否定的前提、连续受挫、测试完整性、独立评测、不可信内容、复现证据、验证边界、交付完整性、工具链缺口、本地版本、来源核验、产物清理。领域知识来自 skill，不塞进内置卡。

## 面板

- **KPI**：生效的规则（来自几个 skill、另有几条通用）、提醒、拦下、提醒后照做（与影子基线对照）、平均每次检查耗时。下方注明统计窗口和更新时间。
- **概览**：顶部一句话说明现在怎么样（一切正常 / 有 skill 没准备好 / 正在准备 / 影子模式），出问题时直接给“重试”按钮；下面是关键数字、活动图表、最近的提醒和 skill 准备情况。
- **活动**：“什么时候检查过”按时间堆叠为提醒或拦下 / 影子模式下本会提醒 / 没提醒；“因为什么检查”用“改代码”“跑检查”“准备交付”这类说法列出各种情况的次数。两张图都能切换成表格。
- **记录**：时间线形式，每条写明在什么时机提醒了哪条规则、为什么。展开后能看到**之后 AI 实际做了什么**（从会话事件里读出的接下来几步动作、它的回复、被拦下的那一步），以及这次看了哪些规则。在 DSH 会话标签页里打开时，每一步都能点“轨迹”直接跳到 Trajectory 里对应的那次调用。
- **规则**：按通用 / 来自 skill / 关键 / 提醒过的筛选和搜索。详情写出原文摘录、什么时候适用、怎样算做到、不适用的情况、只针对哪些文件或命令、出处（文件和行号）、与其他规则的先后关系，以及最近几次检查；动手前检查和“原文里没找到这句话”的规则会单独标出。
- **Skills**：编译过程可视化。顶部是总进度；每个 skill 一张卡片，状态分为已就绪、用到时再准备、准备中、稍后再试、没准备好、已暂停；正在编译的 skill 按正文分段着色（已完成 / 上次做完这次沿用 / 正在编译 / 稍后再试 / 失败 / 等待），并写明原因和该怎么做；下方“过程”按时间列出发生了什么。可以单独准备或重新编译某个 skill，也可以重试、暂停或全部重新编译。
- **关系图**：通用规则在顶部，每个 skill 独立成簇，可以只看某个 skill；鼠标移上去高亮关系，点击查看详情。
- **设置**：服务商、模型、思考强度都是下拉选择，内容直接读自 DSH 的模型目录（`listProviders` / `listModels` / `resolveModelInfo`），思考强度只列出这个模型真实支持的档位，并显示上下文窗口；服务商留空表示跟主对话用同一个。保存前会按模型能力校验。时间以秒、把握以百分比填写。是否拦下操作、影子模式、常驻上下文、面板路径和状态目录只能在配置文件里改，避免被网页误关。

设置写入 `$DSH_HOME/eng-protocol.json`（操作员层），与 profile 的 `config` 分层共存。保存前会用规范化逻辑逐字段校验：越界值、类型错误或未知字段都会让整次保存失败并给出具体原因，不会先落盘再截断。写入需要面板自身发出的同源 JSON 请求，并携带当前 `sessionId`。

会话标签页会把 `sessionId`、`cwd` 和 `scope` 带进 iframe；`/api/stats`、`/api/decisions`、`/api/compile`、`/api/settings` 都按会话解析自己的 agent 和运行图。未指定会话、会话尚未运行或已结束时返回 409 并说明原因，不会退回到“最近活动的项目”——避免在 A 会话旁看到 B 的项目。项目汇总视图需要显式 `scope=project&cwd=…`。

面板每 8 秒自动刷新（可暂停）；数据没有变化时不重绘，展开的决策和悬停状态不受影响。

面板读取 `$DSH_HOME/storages/eng-protocol/decisions.jsonl` 和 skill 编译结果，统计本项目最近 400 次决策。日志从末尾倒着读，当前文件不够时继续读轮转出的 `.1`，文件没有变化时复用上次的解析结果，所以面板常开也不会反复读整个日志。统计文件保存卡片 ID、状态、模型给出的理由摘要和指标，不保存完整对话；理由摘要可能引用当前证据片段。卡片正文和判官理由都是模型生成的文本，面板一律按纯文本渲染。编译控制接口只接受面板自己发出的同源 JSON 请求。

面板使用 DSH 的 `--dsw-*` 语义 token（`bg-layer-1/2`、`border-l1/l2`、`label-primary/secondary/tertiary`、`brand-primary-new-color`、`radius-*`）作为主样式，并为独立打开提供了同一套深色调色板。会话标签页会跟随 DSH 当前的深浅色，以 `?theme=dark|light` 带进面板；单独打开时也可用 URL 参数或右上角 `◐` 切换。

## 评估效果（A/B）

面板上的“注入次数”只说明提醒发出去了，不说明它有用。插件用影子模式提供对照组：

1. **对照组**：设置 `shadow: true`（或在会话里执行 `/protocol shadow`）。插件照常判断并记录“本会注入什么、本会拦截什么”，但不改变对话。
2. **实验组**：正常模式。
3. **指标**：一张卡被送达（影子模式下是“本会送达”）后，同一会话里它的**后续**判断才会结算：要么出现了新证据，要么该判断发生在投递之后。已是 `addressing` / `satisfied` / `inapplicable` 记为“已处理”，`needed` 记为“仍需要”。投递之前就已完成的判断，以及缺少归因元数据的旧记录，分别计入 `pending`、`legacy` 等桶，不进入成功率分母。面板分别显示“提醒后已处理”（实验组）和“影子基线”（对照组）；前者明显高于后者，提醒才算有效。

这是由判官后续判定推出的代理指标。要下结论，应在同一批任务上分别跑两组，再结合任务完成率、返工次数和耗时一起看。常驻上下文不经过判官，它的效果只能通过两组的任务结果对比。

## 数据与隐私

决策模型会收到有界的当前证据：用户请求片段、最近助手文本、最近工具名/路径/命令/结果摘要、检查结果、失败摘要、文件读写列表，以及候选卡规则、原文摘录和关系。完整工具输出不会发送；编译模型只收到 agent 实际用到（或你在面板 / 命令里要求编译）的 skill 正文和宿主元数据。两者都通过 DSH 的 `ctx.llm` 路由，使用主模型同一套凭据和网络配置。

编译结果存放在 `$DSH_HOME/storages/eng-protocol/skills/` 下（按内容命名的独立文件，`parts/` 是分段检查点，`latest/` 记录每个 skill 最近一次好的编译），可以随时整个删除，下次用到时会重新编译。

## 开发与验证

```powershell
npm test
```

等价于依次运行：

```powershell
node tests/smoke.mjs
node tests/compiler.mjs
node tests/integration.mjs
node tests/client.mjs
node tests/scenarios.mjs
node tests/regressions.mjs
node tests/adaptive.mjs
node tests/catalog.mjs
node tests/dashboard-browser.mjs
```

- `smoke.mjs` 覆盖配置归一化与分层、工具分类（含 PowerShell/cmd 危险命令、检查命令、补丁路径）、原文核对与行号、skill 路由与文件范围过滤、本地下限、选择/冷却（按步数）/关系、事件账本、后续指标、决策日志倒读（跨分块、跨轮转文件、多字节字符）、决策轨迹筛选与分页、面板路由与编译接口校验。
- `compiler.mjs` 覆盖 Markdown 分段、摘录定位（容忍空白/大小写/Markdown 标记，不容忍改写）、分段由正文决定、路径与命令匹配、ID 冲突、依赖环、前置卡闭包、覆盖关系、编辑版本和不响应取消的模型适配器。
- `integration.mjs` 用假 LLM 走通 `apply()` → `agent/pre-step` 注入 → `tools/pre-execute` 软拦截一次 → `agent/turn-stopping` 注入。
- `client.mjs` 验证客户端 bundle 注册 `conversation.view` 标签、标签 id/顺序/标题，以及 iframe 指向 `/eng-protocol?embed=1&theme=...`。
- `scenarios.mjs` 用假宿主验证端到端行为：只路由相关 skill、读目录不编译、加载即作用域且只编译一次（跨 agent 共享）、路由提醒是“加载它”而不是改写、常驻上下文只放核对过的原文、动手前检查按文件范围拦截一次、动作后提醒挂在工具结果上、同一步内不重复、冷却按步数、本地下限与授权放行、判官故障时仍拦截、软拦截按回合重置、会话隔离、影子模式、编译中途 skill 变更，以及规则多到一轮装不下时先判入口卡、无关 skill 的规则不送判官。
- `regressions.mjs` 覆盖历次缺陷：复合命令下限、后台任务的真实交接文本与 `job_output` / 完成通知回填、事件账本只有一个 `push`、多段编译的统计与去重、设置保存读回等。
- `adaptive.mjs` 覆盖错误分类与提示、指数退避重试、AIMD 并发、自适应超时、无卡数上限、截断自动拆段且记住拆分、分段断点续传、只重编改动的段、读目录不调模型、失败记录与后台重试、上一版兜底、取消与续编、按内容共享（两个 agent 一次编译、跨项目复用、别的作用域删不掉）、判官批次二分、批大小只在装满答完时变大、同一尺寸失败只缩一次、调用跑超一半时限才缩批（排队超时不算）、时限到了保留已答完的批、有关系的规则同批、逐层展开（入口卡先判、只展开仍相关的 skill、一轮装得下时不分轮、刚调用的 skill 不等入口卡），以及旧预算字段的忽略与清除。
- `catalog.mjs` 覆盖思考强度适配、模型目录、设置校验、提醒之后的动作追踪和编译过程视图。
- `dashboard-browser.mjs` 是真实浏览器检查：默认启动 Windows Edge 无头模式，也可用 `ENG_PROTOCOL_BROWSER` 指定 Chromium 可执行文件；验证 60 个 skill 的拓扑、箭头、筛选、来源详情、“用到时再准备”状态、设置保存和窄屏布局，不增加插件依赖。

宿主事件、`tools/post-execute` 的 `additionalContexts`、`ctx.systemPrompt.context` 与 `agent.inject()` 的语义已对照本地 DSH 源码核验。真实辅助模型的编译质量和完整 DSH 会话效果仍需在运行实例中评估。

## 已知限制

- 编译质量取决于编译模型；原文核对只能证明“这句话确实在原文里”，不能证明“这句话被理解对了”。跨段语义及相对资源的具体内容仍需查阅原 skill。
- skill 在被加载后才编译，加载后的头一两分钟里只有原文本身在起作用（这时原文就在上下文里，影响最小）；如果希望提前看到规则，可在面板点“现在准备”或执行 `/protocol rebuild <名称>`。
- 还没加载的 skill 只有与请求明显相关（点名、描述或改动文件有词语重合）时才会被判断；用词完全不同（例如中文请求对英文描述）时，靠的是宿主自己的 skill 目录提示主模型去加载。
- 事件检测是词法与结构信号；漏掉的事件意味着不评估，`heartbeat` 只是兜底。危险命令识别覆盖常见写法，但不是 shell 解析器，变量展开或脚本里的命令看不到。复合命令按分句判断：`git --version; git push` 里的无关参数不会取消危险子句的本地下限。
- 后台任务只有识别出宿主真实的 job 交接文本才能跟进；无法识别时该检查停留在 `running`，不会被当作通过。`job_output` 的最终状态会回填原来的检查。
- 决策模型误判会带来一次不必要的提醒或一次多余往返。
- 没有卡数上限意味着加载的 skill 很多时判官调用会变多（分批并行）；新回合规则多到一轮装不下时先判入口卡再展开，要多等一轮。可用 `skills.include` / `exclude` 收窄。
- 自适应状态（并发、延迟样本、批大小）只在进程内保存，重启后从安全起点重新学习；编译结果和分段检查点持久化在磁盘上。编译结果目前不自动清理，删除 `skills/` 目录即可回收空间。
- `agent/turn-stopping` 的 `agent.inject()` 是否续跑取决于宿主循环；本实现按 DSH 当前 `next-step` 语义写入，若宿主行为变化，交付前检查会退化为“记录但不续跑”。
- 常驻上下文属于宿主的“可选运行时上下文”，被某些预设整体关闭时它也随之关闭；此时已加载 skill 的要求只能靠触发式提醒送达。
- 面板主体是独立 HTML 页面；客户端半边只注册 `conversation.view` 标签并用 iframe 嵌入它，因此不需要重建 Web 资源，但也不复用 DSH 的组件库。
- 没有跨会话持久记忆；`/protocol on | off | shadow` 的会话覆盖只保存在进程内。决策日志超过 8 MiB 时轮转（保留一份 `.1`）。轮转与追加按日志路径串行执行，同一进程内的并发写不会丢档；跨进程同时写同一个日志仍不保证互斥。
- “提醒后已处理”是判官给出的代理指标，不等于任务结果。结算要求新证据或投递之后的判断；否则该送达只计入 `pending`。
- 判官缓存只作用于工具边界、且默认 15 秒内相同证据与动作才复用；请求与交付边界始终重新判断，因为作用域复核依赖它们。

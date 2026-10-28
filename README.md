**[中文](#zh)** · **[English](#en)**

<a id="zh"></a>

# omo-langsmith

OmO Native 的 senpi 扩展。OmO Native 是 npm 包 `omo-ai` 提供的 `omo` 命令行，构建在 [senpi](https://github.com/code-yeongyu/senpi) 引擎上。本扩展把 OmO 的运行过程发到 [LangSmith](https://smith.langchain.com)：每条用户提示是一条 trace（根 run 类型为 `chain`），同一次 OmO 会话里的 trace 归到同一个 LangSmith Thread。LLM run 带上 token 用量，并在 senpi 能标价时带上费用。

## 轨迹结构

一次用户提示对应一条 trace，根 run 的 `metadata.session_id` 和 `metadata.thread_id` 都是 OmO 的 session id。LangSmith 按这个 thread id 把同一会话的 trace 收成一个 Thread。

```text
omo.agent          (chain)   每条用户提示一条
└─ turn N          (chain)   每一轮一条（一次模型回复，加上它调用的工具）
   ├─ <model id>   (llm)     输入是最近的上下文消息；输出是助手消息和 usage_metadata
   └─ <tool name>  (tool)    每个工具调用一条；嵌套工具挂在父工具 run 下面
```

补充行为（均来自 `langsmith.ts`）：

- 只在 `before_agent_start` 里 `preview !== true` 时记下提示。提示缓存预览不会开 trace。
- LLM 的输入取自 `context` 事件里的消息，且忽略 `source === "projection"` 的摘要投影，只用真正发给模型的上下文。
- 条数由 `OMO_LANGSMITH_MAX_INPUT_MESSAGES` 截断（见下文）。`metadata` 里同时有 `context_messages_total` 和 `context_messages_sent`。
- 模型名用当前 `model.id`，没有则用消息上的 model，再没有则叫 `llm`。`metadata` 里有 `ls_provider` 和 `ls_model_name`。
- 工具的父 run 优先是 `parentToolCallId` 对应的工具 run，否则是当前 turn，再否则是这条 agent trace。
- 助手消息的 `stopReason` 为 `error` 或 `aborted` 时，LLM run 记为错误。工具 `isError` 时，工具 run 记为错误。会话中途关掉时，未结束的 run 会带上关闭原因。

### Token 用量和费用

LLM run 的输出里有 `usage_metadata`，字段从 senpi 的 usage 对象换算：

| 字段 | 来源 |
| --- | --- |
| `input_tokens` | `input + cacheRead + cacheWrite` |
| `output_tokens` | `output` |
| `total_tokens` | `totalTokens`，没有则用 input 与 output 之和 |
| `input_token_details.cache_read` | `cacheRead` |
| `input_token_details.cache_creation` | `cacheWrite` |
| `output_token_details.reasoning` | 仅当 `reasoning` 是数字时写入 |
| `input_cost` | `cost.input + cost.cacheRead + cost.cacheWrite` |
| `output_cost` | `cost.output` |
| `total_cost` | `cost.total` |

费用只在 `cost` 存在且 `costUnknown` 不为真时写入。没有已知价格的模型只上报 token，不上报金额。

## 安装

把本目录复制或克隆到 OmO 的扩展目录，安装生产依赖，然后重启 `omo`，或在会话里执行 `/reload`。

```bash
git clone https://github.com/hkmdxlftjf/omo-langsmith.git ~/.omo/agent/extensions/omo-langsmith
cd ~/.omo/agent/extensions/omo-langsmith
bun install --production
```

没有 bun 时，等价命令是 `npm install --omit=dev`。`langsmith` 是运行时依赖；`typescript` 和 `@code-yeongyu/senpi` 只在本仓库做类型检查时需要，生产安装不会装它们。扩展入口由 `package.json` 的 `pi.extensions` 指向 `./langsmith.ts`。

正常工作时，状态栏出现 **LangSmith ●**。这是 `session_start` 里成功构造 LangSmith client 之后写上的状态（`ctx.ui.setStatus("langsmith", "LangSmith ●")`）。没有 `LANGSMITH_API_KEY`，或设置了 `OMO_LANGSMITH_DISABLED=1` 时，扩展在加载时直接返回，不会出现这个状态。

senpi 文档里的目录是 `~/.senpi/agent`。OmO 用的是 `~/.omo/agent`。请装到 `~/.omo/agent/extensions/omo-langsmith/`，不要装到 senpi 文档里的那个路径。

## 环境变量

`LANGSMITH_API_KEY` 和下面的 `OMO_LANGSMITH_*` 开关在扩展加载时读取（默认导出函数一运行就读）。改完需要重启 `omo` 或执行 `/reload`。`new Client()` 在 `session_start` 时构造，注释写明它读取 `LANGSMITH_API_KEY`、`LANGSMITH_ENDPOINT` 和 `LANGSMITH_WORKSPACE_ID`。项目名和 agent 地址由 LangSmith SDK 从环境变量读取；本文件头部记录的约定如下。

| 变量 | 是否必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LANGSMITH_API_KEY` | 必需 | 无 | 没有它扩展什么都不做 |
| `LANGSMITH_PROJECT` | 项目型 workspace 使用 | `default` | 追踪项目名。不要和下面两个 agent 变量一起设 |
| `LANGSMITH_ENDPOINT` | 非美国区域需要 | `https://api.smith.langchain.com` | 欧盟 `https://eu.api.smith.langchain.com`，亚太 `https://apac.api.smith.langchain.com`。密钥不能跨区域使用 |
| `LANGSMITH_AGENT_ID` | agent 型 workspace 使用 | 无 | 与 `LANGSMITH_AGENT_ENVIRONMENT` 成对设置，并且不要同时设置 `LANGSMITH_PROJECT` |
| `LANGSMITH_AGENT_ENVIRONMENT` | 同上 | 无 | 与 `LANGSMITH_AGENT_ID` 一起设置 |
| `LANGSMITH_WORKSPACE_ID` | 仅当一把密钥跨多个 workspace | 无 | 由 `new Client()` 读取，用来选定 workspace |

`LANGSMITH_AGENT_ID` 与 `LANGSMITH_AGENT_ENVIRONMENT` 必须成对出现，并且与 `LANGSMITH_PROJECT` 互斥。这是本扩展头部注释写下的约定，由 LangSmith 客户端执行，本文件里没有再做一次校验。

## 可选开关

名字和默认值与 `langsmith.ts` 里的读取方式一致。数字开关用 `intEnv`：非数字或负数会退回默认值，`0` 是合法值。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OMO_LANGSMITH_DISABLED` | 不设置（开启） | 设为 `1` 则关闭扩展，不必删文件。只有字符串 `1` 会关闭 |
| `OMO_LANGSMITH_MAX_INPUT_MESSAGES` | `30` | 每个 LLM run 附带的上下文消息条数，取最近的若干条。`0` 表示全部发送 |
| `OMO_LANGSMITH_MAX_CHARS` | `20000` | 每段文本的字符上限，超出部分截断并注明被截掉的长度。`0` 表示不截断 |
| `OMO_LANGSMITH_SYSTEM_PROMPT` | 关闭 | 设为 `1` 时，每条 agent run 的输入里额外带上系统提示（通常很大） |
| `OMO_LANGSMITH_THINKING` | 开启（会发送） | 设为 `0` 则丢掉模型的 thinking / reasoning 文本。未设置为 `0` 时都会发送 |
| `OMO_LANGSMITH_REDACT` | 开启 | 设为 `0` 则跳过 senpi 的 `redactForUpload`（与 `/share` 相同的脱敏）。未设置为 `0` 时都会脱敏 |
| `OMO_LANGSMITH_DEBUG` | 关闭 | 设为 `1` 时，把追踪失败打到 stderr，前缀是 `[omo-langsmith]`。否则错误被吞掉，避免影响代理本身 |

## 隐私

用户提示、上下文里的代码和对话、助手回复、工具参数和工具输出都会上传到 LangSmith。图片会换成占位文本，不会上传图片本体。系统提示默认不上传，除非打开 `OMO_LANGSMITH_SYSTEM_PROMPT=1`。

脱敏调用的是 senpi 的 `pi.redactForUpload`，和 `/share` 用的是同一套。它只是尽力而为：脱敏抛错时会保留原文再上传，它也不能保证每个秘密都被去掉。字符截断只是缩短字段，不是隐私手段。请只把 trace 发到你愿意存放这些内容的 LangSmith workspace。

## 开销

上报是异步的，不阻塞代理。`postRun` / `end` / `patchRun` 都在后台执行，失败只在调试开关打开时打印。LangSmith 客户端会把请求攒批发送。

进程退出时，`session_shutdown` 会等待未完成的批次，最多 **1.5 秒**，或者提前收到宿主的 abort 信号就停。扩展注释里写的是：所有扩展共享大约 2 秒的退出预算，所以上传只占其中的 1.5 秒。超时后剩余批次会被丢掉。

## 已知限制

- 尚未在真实的 `omo` 安装上验证过。
- 子代理（subagent）下的行为未经确认。嵌套工具调用会按 `parentToolCallId` 挂到父工具 run 上，但子代理是否走这条路径、会话 id 如何划分，都还没有在真实 OmO 里核对。
- 编译后的 `omo` 如何解析本扩展的依赖，未经确认。预期布局是本目录里有一份安装出来的 `node_modules/langsmith`，和 `langsmith.ts` 放在一起。如果打包后的 `omo` 不从扩展目录解析模块，运行时会找不到 `langsmith`。

---

<a id="en"></a>

# omo-langsmith

A senpi extension for OmO Native. OmO Native is the `omo` CLI from the npm package `omo-ai`, built on the [senpi](https://github.com/code-yeongyu/senpi) engine. This extension sends OmO activity to [LangSmith](https://smith.langchain.com). Each user prompt is one trace (a root run of type `chain`). Traces from the same OmO session are grouped into one LangSmith Thread. LLM runs carry token usage, and cost when senpi was able to price the call.

## Trace structure

One user prompt produces one trace. The root run sets both `metadata.session_id` and `metadata.thread_id` to the OmO session id. LangSmith groups traces that share that thread id into one Thread.

```text
omo.agent          (chain)   one per user prompt
└─ turn N          (chain)   one per turn (one model reply, plus the tools it called)
   ├─ <model id>   (llm)     inputs are the recent context messages; outputs are the assistant message and usage_metadata
   └─ <tool name>  (tool)    one per tool call; nested tool calls hang off their parent tool run
```

Details taken from `langsmith.ts`:

- The prompt is recorded on `before_agent_start` only when `preview` is not `true`. A prompt-cache preview does not open a trace.
- LLM inputs come from the `context` event. Events with `source === "projection"` (summarizer projections) are ignored, so the run records the context actually sent to the model.
- How many of those messages are attached is controlled by `OMO_LANGSMITH_MAX_INPUT_MESSAGES` (below). Metadata records both `context_messages_total` and `context_messages_sent`.
- The LLM run is named with the current `model.id`, then the model on the message, then `"llm"`. Metadata includes `ls_provider` and `ls_model_name`.
- A tool run's parent is the tool run for `parentToolCallId` when that exists, otherwise the current turn, otherwise the agent trace.
- An assistant `stopReason` of `error` or `aborted` ends the LLM run as an error. A tool with `isError` ends that tool run as an error. If the session closes mid-run, unfinished runs are closed with the shutdown reason.

### Token usage and cost

Each LLM run's outputs include `usage_metadata`, mapped from senpi's usage object:

| Field | Source |
| --- | --- |
| `input_tokens` | `input + cacheRead + cacheWrite` |
| `output_tokens` | `output` |
| `total_tokens` | `totalTokens`, or the sum of the input and output counts when that is missing |
| `input_token_details.cache_read` | `cacheRead` |
| `input_token_details.cache_creation` | `cacheWrite` |
| `output_token_details.reasoning` | set only when `reasoning` is a number |
| `input_cost` | `cost.input + cost.cacheRead + cost.cacheWrite` |
| `output_cost` | `cost.output` |
| `total_cost` | `cost.total` |

Cost fields are written only when `cost` is present and `costUnknown` is not set. A model with no known price reports tokens and omits dollar amounts.

## Install

Copy or clone this directory into OmO's extensions directory, install production dependencies, then restart `omo` or run `/reload` in a session.

```bash
git clone https://github.com/hkmdxlftjf/omo-langsmith.git ~/.omo/agent/extensions/omo-langsmith
cd ~/.omo/agent/extensions/omo-langsmith
bun install --production
```

Without bun, the equivalent is `npm install --omit=dev`. `langsmith` is the runtime dependency. `typescript` and `@code-yeongyu/senpi` are only needed to typecheck this repository, and a production install skips them. The extension entry is `./langsmith.ts`, declared in `package.json` under `pi.extensions`.

When it is working, the status line shows **LangSmith ●**. That string is set in `session_start` after the LangSmith client is constructed (`ctx.ui.setStatus("langsmith", "LangSmith ●")`). If `LANGSMITH_API_KEY` is missing, or `OMO_LANGSMITH_DISABLED=1`, the extension returns as soon as it loads and the status never appears.

Senpi's own docs refer to `~/.senpi/agent`. OmO uses `~/.omo/agent`. Install under `~/.omo/agent/extensions/omo-langsmith/`, not the path in the senpi docs.

## Environment variables

`LANGSMITH_API_KEY` and the `OMO_LANGSMITH_*` switches below are read when the extension loads (the default export reads them immediately). Restart `omo` or run `/reload` after changing them. `new Client()` runs on `session_start`. The comment there says the client reads `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, and `LANGSMITH_WORKSPACE_ID`. The project name and agent address are read from the environment by the LangSmith SDK. The contract recorded in this file's header is:

| Variable | Required | Default | Role |
| --- | --- | --- | --- |
| `LANGSMITH_API_KEY` | yes | none | without it the extension does nothing |
| `LANGSMITH_PROJECT` | project-based workspaces | `default` | tracing project name. Do not set this together with the two agent variables |
| `LANGSMITH_ENDPOINT` | required outside the US region | `https://api.smith.langchain.com` | EU: `https://eu.api.smith.langchain.com`. APAC: `https://apac.api.smith.langchain.com`. A key from one region is not valid in another |
| `LANGSMITH_AGENT_ID` | agent-based workspaces | none | set together with `LANGSMITH_AGENT_ENVIRONMENT`, and do not also set `LANGSMITH_PROJECT` |
| `LANGSMITH_AGENT_ENVIRONMENT` | same | none | set together with `LANGSMITH_AGENT_ID` |
| `LANGSMITH_WORKSPACE_ID` | only when one key spans multiple workspaces | none | read by `new Client()` to pick the workspace |

`LANGSMITH_AGENT_ID` and `LANGSMITH_AGENT_ENVIRONMENT` are a pair, and that pair is mutually exclusive with `LANGSMITH_PROJECT`. That is the contract written in this extension's header. The LangSmith client enforces it; this file does not check it again.

## Optional switches

Names and defaults match the reads in `langsmith.ts`. Numeric switches go through `intEnv`: a non-numeric or negative value falls back to the default, and `0` is a valid value.

| Variable | Default | Effect |
| --- | --- | --- |
| `OMO_LANGSMITH_DISABLED` | unset (enabled) | set to `1` to turn the extension off without removing it. Only the string `1` disables it |
| `OMO_LANGSMITH_MAX_INPUT_MESSAGES` | `30` | how many context messages are attached to each LLM run, keeping the most recent ones. `0` sends all of them |
| `OMO_LANGSMITH_MAX_CHARS` | `20000` | cap on each text field. Longer text is truncated, with a note of how many characters were cut. `0` disables the cap |
| `OMO_LANGSMITH_SYSTEM_PROMPT` | off | set to `1` to also attach the system prompt (often large) on each agent run |
| `OMO_LANGSMITH_THINKING` | on (sent) | set to `0` to drop model thinking / reasoning text. Any value other than `0`, including unset, sends it |
| `OMO_LANGSMITH_REDACT` | on | set to `0` to skip senpi's `redactForUpload` (the same redactor as `/share`). Any value other than `0`, including unset, redacts |
| `OMO_LANGSMITH_DEBUG` | off | set to `1` to print tracing failures to stderr with the prefix `[omo-langsmith]`. Otherwise errors are swallowed so tracing cannot break the agent |

## Privacy

User prompts, code and conversation in the model context, assistant replies, tool arguments, and tool results are uploaded to LangSmith. Images are replaced with a placeholder; the image bytes are not uploaded. The system prompt is left out unless `OMO_LANGSMITH_SYSTEM_PROMPT=1`.

Redaction calls senpi's `pi.redactForUpload`, the same path `/share` uses. It is best-effort only. If redaction throws, the original text is what gets uploaded, and a successful pass still does not guarantee every secret was removed. The character cap only shortens fields; it is not a privacy control. Send traces only to a LangSmith workspace you are willing to store this data in.

## Overhead

Uploads are asynchronous and do not block the agent. `postRun`, `end`, and `patchRun` run in the background. Failures are printed only when the debug switch is on. The LangSmith client batches requests.

On exit, `session_shutdown` waits for pending batches for at most **1.5 seconds**, or until the host abort signal fires. The extension comment notes that every extension shares a quit budget of about 2 seconds, so the flush takes at most 1.5 seconds of that. Batches still in flight after the timeout are dropped.

## Known limitations

- This has not yet been verified on a real `omo` install.
- Behaviour with subagents is unconfirmed. Nested tool calls are parented with `parentToolCallId`, but whether subagents use that path, and how session ids are split, has not been checked against a real OmO session.
- Dependency resolution under a compiled `omo` binary is unconfirmed. The expected layout is an installed `node_modules/langsmith` sitting next to `langsmith.ts` in this directory. If the packaged `omo` binary does not resolve modules from the extension directory, `langsmith` will not be found at runtime.

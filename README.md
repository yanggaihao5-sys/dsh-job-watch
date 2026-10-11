# dsh-job-watch

**A long-running job you did not start, pinned to the conversation that cares about it.**
The sidebar row of that conversation turns **pink** while the job runs, **green** once it has
finished (come back and analyse the result), and **amber** when the job id cannot be found.

[English](README.md) | [中文速览](#中文速览)

> **Not affiliated with DeepSeek.** This is an independent community plugin for
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). "DeepSeek Harness" is named
> only to describe compatibility.

---

## The problem

An agent submits a job that takes six hours — to a cluster scheduler, to a bare-metal box over SSH, to
`tmux` somewhere — and then the session goes quiet. The job's state lives in a completely different program
(`squeue`, `bjobs`, `tmux list-sessions`), so the only ways to find out are:

- open a terminal and poll it by hand, or
- keep a monitoring tab open, or
- notice four hours later that it finished and you never looked.

The GUI already knows which conversation you were working in. `dsh-job-watch` attaches the job id to that
conversation, queries the provider for you, and paints the conversation's row — so "which conversation still
has something running, and which one finished while I was away" is answered by the sidebar you are already
looking at.

```
□ conv A  ·  (no mark)                       nothing to do
▌ conv B  ·  ●  pink, pulsing                a tracked job is running
▌ conv C  ·  ●  green                        finished — come back and analyse
▌ conv D  ·  ●  amber                        the id cannot be found by its provider
```

Green is deliberately sticky: it does **not** expire, because it exists to make you come back. It clears the
moment you actually say something in that conversation — and injected context (workspace instructions, skill
catalogs, runtime snapshots) does not count as "saying something", because that would clear it silently and
defeat the whole feature.

## Screenshot

![Three tracked conversations, each carrying the running colour on its sidebar row](docs/demo.png)

> A real screenshot of the sidebar: three tracked conversations, each with the **running** bar
> (`#ec4899`, the exact colour the plugin paints) on the left edge of its row. The conversation titles are
> covered by a solid block — they are the author's private session names, and the crop is verified pixel by
> pixel to contain no text at all. No green example appears here simply because no tracked job had finished
> when the shot was taken; green means "finished, come back and analyse".

## How it works

| Half | Runs in | Does |
|---|---|---|
| **host** (`lib/index.js`) | the `dsh` process | the job ledger, the provider poller, the `job_watch` agent tool, `/api/job-watch/*` |
| **browser** (`lib/client.js`) | the Web GUI | reads the state endpoint and paints the sidebar rows |

The plugin owns **no** job logic. A *provider* is a shell command plus one regex applied per output line —
so an HPC scheduler, `tmux` on a bare-metal box, or your own status CLI are all the same thing to it.
Nothing about a cluster, queue or path is hard-coded.

Queries happen on four triggers, all of them cheap and skipping each other:

| Trigger | Why it exists |
|---|---|
| every `pollMinutes` (default 30) | the normal rhythm |
| a 60 s heartbeat that compares the wall clock against the monotonic clock | a suspended machine freezes timers, so a timer firing "on time" proves nothing; clock drift > 90 s is the evidence of a sleep, and the poll catches up right away |
| opening / refocusing the GUI | you are here, so the state you are shown should be current (the host only re-queries if the ledger is older than `requestStaleSeconds`) |
| right after `register` | the colour must be correct immediately, not in 30 minutes |

## Install

```sh
dsh plugin --profile web add dsh-job-watch
```

Restart `dsh web` afterwards (`--profile` must come **after** `plugin` — the other order is rejected).

Then configure at least one provider in your profile patch, `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: job-watch
  config:
    pollMinutes: 30
    providers:
      # 1) a scheduler that prints one job per line (Slurm here: id, state, name)
      - id: cluster
        label: Cluster
        command: 'ssh login01 "squeue -u $USER -h -o ''%i %T %j''"'
        linePattern: '^(?<id>\S+)\s+(?<stat>\S+)\s+(?<name>\S+)$'

      # 2) a bare-metal box where "a job" is a tmux session name
      - id: lab
        label: Lab box
        command: 'ssh lab "tmux list-sessions -F ''#{session_name}''"'
        linePattern: '^(?<id>[A-Za-z0-9_.-]+)$'
```

`linePattern` is applied **per line**; it needs a named group `id`, and may add `stat` and `name`. Lines that
match nothing are ignored, so headers, banners and warnings cost nothing. ANSI colour codes are stripped
first, which matters as soon as your command runs through a shell that thinks it is talking to a terminal.

### Provider reference

| Key | Required | Meaning |
|---|---|---|
| `id` | ✅ | the name used by `job_watch(provider=…)` and shown in the tooltip |
| `label` | | human-readable name for messages |
| `command` | ✅ | run through the platform shell; write the SSH call yourself, so no remote details live in the plugin |
| `linePattern` | ✅ | regex per line, named group `id` (required), `stat`, `name` (optional) |
| `runningStates` | | overrides the default list (`RUN`, `PEND`, `QUEUE`, `WAIT`, …) |
| `doneStates` | | overrides the default list (`DONE`, `EXIT`, `FAIL`, `ABORT`, `KILL`, …) |

Other config: `pollMinutes`, `heartbeatSeconds`, `commandTimeoutSeconds`, `minPollGapSeconds`,
`requestStaleSeconds`, `unknownAfterSeconds`, `pruneDays` (finished + acknowledged rows are dropped after
this long), `missingMeans` (`done` = a job vanishing from its provider's listing has finished; `unknown` =
paint it amber instead), `statePath` (default `$DSH_HOME/job-watch.json`).

A non-zero exit from a provider command is **not** fatal: `tmux list-sessions` exits 1 when there are no
sessions, and several schedulers print the listing while warning on stderr. stdout is parsed either way and
the failure is reported alongside the state.

## Agent integration

The host injects a short rule into every agent's system prompt, and exposes one tool:

```
job_watch(action='register', jobIds=['40217'], provider='cluster', etaMinutes=540, note='sweep A')
job_watch(action='list')
job_watch(action='refresh')
job_watch(action='clear')
```

- `register` without `jobIds` **auto-claims**: every job the providers currently list as running and that no
  conversation tracks yet. Useful after the fact ("what did I forget to register?").
- ***Registering is not optional.*** No colour can be inferred from a job that nobody told the plugin about —
  a job submitted in `tmux` or on a cluster leaves no trace in the ledger. This is why the rule lives in the
  system prompt rather than in a doc nobody reads.
- Every report ends each job with a **recommended finish time**. It is arithmetic (registration time + the
  ETA you registered) or an explicit "cannot be estimated, here is how to measure it" — the plugin never
  invents a time. An ETA that has already elapsed while the provider still reports the job as running is
  called out as overdue rather than assumed finished.
- `SKILL.md` is the same contract written for an agent that loads skills.

## Limitations (measured, not guessed)

- **The sidebar has no decoration API.** The browser half finds a row's session id through the React fiber
  chain hanging off the row DOM node and injects the marker into the row. This is inherently tied to the
  current sidebar implementation; when it breaks, the console and `window.__dshJobWatch.stats()` say so
  instead of failing silently.
- **`register` is a manual step** — see above. There is no way around it for jobs DSH did not spawn.
- **Only rows the sidebar renders get a colour.** A conversation that is not in the visible list is not
  painted (the rollup is still computed, so it paints as soon as the row appears).
- **`linePattern` is yours to get right.** A pattern that matches the header row as a job will track a fake
  job; a pattern that matches nothing silently tracks nothing (which is why `refresh` reports how many ids
  each provider listed).
- **No test of the GUI itself.** `node --test test/kernel.test.mjs` covers the kernel — listing parsing, STAT
  folding, the real-prompt discriminator, and the finish-time contract.

## Prior art, and what is actually new here

Job *listing* is not new, and none of it is claimed as an idea of this plugin. In the DSH ecosystem:

| Project | What it covers | Why this is different |
|---|---|---|
| official `@deepseek-ai/dsh-client-ui-jobs` (the `ui-jobs` entry) | background jobs **DSH itself spawned**, in the session header | this is for jobs DSH did **not** start: a scheduler, a tmux session, another machine |
| [`lql341/dsh-scnet`](https://github.com/lql341/dsh-scnet) | SCNet HPC as **tools + a skill** (submit, status, logs, cancel) | on-demand tool calls for one specific platform; no conversation-level colour, no ETA contract |
| [`Gczmy/dsh-node-sched`](https://github.com/Gczmy/dsh-node-sched) | a **dashboard** for their own `sched` daemon | requires that daemon; a main-panel view rather than the conversation list |
| [`Luaphes/dsh-web-attention-badge`](https://github.com/Luaphes/dsh-web-attention-badge) | **session** attention state in the browser tab bar (amber = waiting on you, green = done) | a session has finished, not a job; painted in the tab strip, not on the conversation row |
| [`catsenior507/dsh-command-center`](https://github.com/catsenior507/dsh-command-center) | a panel for running background jobs | a panel you open, not a colour on the row you are already reading |

The increment claimed here is narrow: **an external job id → a colour on that conversation's sidebar row**,
plus the finish-time contract (arithmetic or an explicit refusal to guess) and the sleep/wake-safe poller.
Everything else — the job tools, the dashboards, the attention badges — belongs to the projects above.

## License

MIT. See [LICENSE](LICENSE).

---

## 中文速览

**问题**：作业交出去要跑几小时，状态却在另一个程序里（`squeue` / `bjobs` / `tmux list-sessions`），于是
要么手动开终端轮询，要么四小时后才发现早跑完了。

**做法**：把作业号绑到**当前对话**上，插件自己按配置的 provider 去查，**侧边栏那一行**直接变色 ——
🩷 粉 = 在跑 ｜ 🟢 绿 = 已结束，回来分析 ｜ 🟠 橙 = 查不到。绿色**不会自己过期**（它就是要喊你回来），
你在那个对话里**真的说话**之后才消失（注入的上下文不算说话）。

**provider 就是「一条命令 + 一行一条的正则」**，所以调度器、裸机 tmux、你自己的状态 CLI 都是同一种东西：
插件里**不写死任何集群、队列、路径**。查询有四条触发（定时 / 心跳发现休眠唤醒 / 打开页面 / 注册后立刻）。

**必做**：`dsh plugin --profile web add dsh-job-watch`，重启 `dsh web`，然后在
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里配 `providers`（见上文）。**每次提交作业后必须登记**
——没人登记的作业不会有任何颜色，这是设计约束，不是 bug：

```
job_watch(action="register", jobIds=["40217"], provider="cluster", etaMinutes=540)
```

每条报告都会给出**推荐结束时间**：要么是「登记时刻 + 你给的 ETA」算出来的，要么明确说**无法可靠推算**
并告诉你从哪取数（作业自身的 elapsed 列 / 日志里的进度行）——**不编时间**。

**与既有项目的关系**：官方 `ui-jobs` 管的是 **DSH 自己起的**后台任务；`dsh-scnet` 是 SCNet 的工具+技能；
`dsh-node-sched` 是自家 `sched` 守护进程的看板；`dsh-web-attention-badge` 是标签页里的会话注意力状态；
`dsh-command-center` 是要打开的作业面板。**本插件只占一格**：**外部作业 → 对话列表那一行的颜色** +
结束时间口径 + 抗休眠的轮询。

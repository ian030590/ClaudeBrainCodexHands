# ClaudeBrainCodexHands

Claude 當腦，Codex 當手。

這組 Claude Code hook 讓 Claude 負責規劃、派工與核查，將實作和較大的調查交給本機 Codex CLI。Claude 收到結果後，檢查實際差異並執行驗收，再回覆使用者。

## 我的訂閱配置

| 工具 | 我的訂閱金額 | 在這個流程中的工作 |
| --- | --- | --- |
| Codex | US$100 | 讀取專案、修改程式、執行測試、回報結果 |
| Claude | US$20 | 理解需求、規劃、派工、核查與回覆 |

這是我個人的訂閱配置。worker 使用本機 Codex 設定中的模型；使用這組 hook 不需要與我採用相同的訂閱金額。

## Hook 如何運作

| Claude Code 事件 | 行為 |
| --- | --- |
| `SessionStart` | 載入 Claude 的主管分工與 Codex 呼叫方式 |
| `UserPromptSubmit` | 每次提交提示時重申分工 |
| `PreToolUse` | 拒絕內建 `Agent`、舊名 `Task` 與 `TeamCreate`，提示 Claude 改用 Codex worker |

被拒絕的 `Agent` 呼叫不會自動啟動 Codex。Claude 會依 hook 的指示，透過 Bash 啟動 worker。`TaskOutput` 保持可用，供 Claude 取得背景工作的結果。

每個 worker 都是獨立工作階段。Claude 必須傳入必要背景、允許修改的範圍、專案限制與驗收條件。Codex 不會自動取得 Claude 的對話或記憶。

## 安裝

需要 Node.js 22 以上、Claude Code，以及透過 npm 安裝的 Codex CLI：

```sh
npm install -g @openai/codex
codex login
claude --version
codex --version
```

已驗證的 CLI 版本是 Claude Code `2.1.319` 與 Codex CLI `0.167.0`。Claude Code 必須支援 command hook 的 `args` 與 `onFailure` 欄位。Codex CLI 必須支援 worker 使用的非互動執行參數。

Clone 後，在專案目錄安裝：

```sh
git clone https://github.com/ian030590/ClaudeBrainCodexHands.git
cd ClaudeBrainCodexHands
node scripts/install.cjs
```

安裝程式會先備份原本的 `~/.claude/settings.json`，再加入三組使用者層級 hook。重新開啟 Claude Code 後生效，之後一般開發任務會使用這個分工。

安裝後的檔案位於：

```text
~/.claude/
  hooks/ClaudeBrainCodexHands/
    codex-supervisor.cjs
    codex-worker.cjs
  backups/ClaudeBrainCodexHands/
  settings.json
```

若有設定 `CLAUDE_CONFIG_DIR`，安裝程式會使用該目錄。也可以用 `--config-dir` 指定其他目錄，例如先驗證安裝與移除：

```sh
node scripts/install.cjs --config-dir ./hook-sandbox
node scripts/install.cjs --config-dir ./hook-sandbox --uninstall
```

worker 使用你本機 Codex CLI 原有的登入與模型設定，登入資料維持在本機 Codex 的既有位置。

## 工作流程

收到開發任務後，Claude 先定義修改範圍與驗收條件，再啟動 Codex worker。唯讀調查使用 `read-only`；授權實作時使用 `workspace-write`。修改範圍重疊的工作應依序執行。

worker 完成後，Claude 應檢查實際差異、確認修改範圍，並親自執行必要的驗收。worker 的完成報告不能代替核查；需要修正時，Claude 應再交給 Codex 處理。一般問答可以由 Claude 直接回答。

也可以手動呼叫 worker。以下是 Bash 範例，請換成實際的安裝與專案路徑：

```bash
node "$HOME/.claude/hooks/ClaudeBrainCodexHands/codex-worker.cjs" \
  --cwd "/absolute/path/to/project" --sandbox workspace-write <<'CODEX_TASK'
修正指定問題。只修改約定的檔案，遵守專案指示，執行相關測試後回報結果。
CODEX_TASK
```

省略 `--sandbox` 時，worker 預設使用 `read-only`。Claude 處於規劃模式時，主管提示要求只啟動唯讀 worker。

## 紀錄與權限

worker 將執行事件、診斷輸出、狀態與最後報告寫入本機的 `~/.claude/codex-workers/`，或 `CLAUDE_CONFIG_DIR` 下的同名目錄：

- `events.jsonl`：Codex 執行事件。
- `stderr.log`：診斷輸出。
- `status.json`：執行狀態與退出碼。
- `result.md`：Codex 最後報告。

非零退出碼或缺少最後報告都視為失敗。已產生的部分報告仍可供核查，不能視為任務完成。

worker 透過 stdin 接收任務，不經 shell 展開，並關閉 Codex 再開子代理的能力。它使用 `--ask-for-approval never`，遇到超出 sandbox 的操作時應回報限制。

內建子代理的拒絕由 hook 執行；Claude 的主管分工與禁止遞迴啟動 Claude，則由提示約束。本專案沒有封鎖 Claude 的所有寫檔命令。Codex 使用自己的 sandbox，不會繼承 Claude 每一條工具權限規則，因此 Claude 必須在委派內容中傳入專案限制。

安裝設定會記錄當時 Node 的完整執行路徑。若移除或切換該 Node 安裝，請重新執行安裝程式。Windows 強制終止程序時，無法保證觸發 worker 的中斷清理。

## 測試與驗證範圍

離線測試不需要登入，也不會呼叫模型：

```sh
npm test
```

測試涵蓋 hook 回應、原生子代理攔截、規劃模式提示、worker 參數、成功與失敗路徑，以及安裝與移除時的設定保留。

初版已在 Windows 實際載入 Claude 啟動 hook，並以真實 Codex worker 修改隔離測試檔、執行檢查。當時 Claude 因用量上限無法繼續，因此完整的「Claude 委派、Codex 執行、Claude 驗收」流程尚未完成整段驗證。macOS 與 Linux 尚未進行實機驗證。

## 移除

```sh
node scripts/install.cjs --uninstall
```

移除程式只清除本專案的 hook 設定，保留其他設定、備份、已安裝的腳本與執行紀錄。若安裝時指定了 `--config-dir`，移除時也要指定相同目錄。重新開啟 Claude Code 後生效。

## 參考文件

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Codex 非互動模式](https://learn.chatgpt.com/docs/non-interactive-mode)

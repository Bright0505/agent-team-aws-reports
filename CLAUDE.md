# AWS 架構報告 Agent Team

依 AWS Well-Architected Framework 四大支柱（安全性、可靠性、效能效率、成本最佳化），
以唯讀掃描實際 AWS 帳號為依據，產出繁體中文架構報告（Markdown + HTML）。

## 鐵則

- **對 AWS 帳號全程唯讀**：只允許 `describe-*` / `list-*` / `get-*` 類 API，任何 agent 都不得執行變更帳號狀態的指令
- **dontAsk 的語意是「不問＝自動拒絕」**：allow 內靜默放行、deny 內擋下、兩者皆非→自動拒。
  因此 **allow 清單是 dontAsk 下唯一的放行通道，不是死配置**——新增會被主對話或 agent 直接呼叫的
  腳本時，**必須同步加 allow 條目**（2026-07 就因 archive-report.sh 漏加而在無人值守中被拒，
  流程被迫用 Read/Write 手動複製）。權限類改動要用**全新 session** 驗證，改設定的 session 驗不出來。
- **唯讀的強制層在 IAM，不在權限提示**：掃描與補查一律使用唯讀憑證 profile（掛 AWS 管理政策
  `ReadOnlyAccess`），寫入 API 在帳號側直接 AccessDenied——構造上完備，任何本機指令繞法都無效。
  模型層保留兩道輔助防線：settings 的 aws 寫入 deny 清單、以及「`aws` 指令必須是字面量」規則
  （deny 是字串比對，`$變數`/`$(...)` 展開會讓它失明）。本機權限已放寬為 `dontAsk`
  （不再逐條跳提示；deny 清單在此模式下仍然生效），**不要**把唯讀保證寄託在權限提示上
- **精簡只在本機做，不在擷取端做**：`scan.sh` 一律抓完整 JSON，精簡交給 `digest.sh`（本機 jq）。
  不要改用 AWS CLI 的 `--query` 裁切——那是「擷取時破壞、不可逆」，欄位判斷錯了只能重掃帳號，
  而重掃時帳號狀態已變，會破壞報告「期別＝已結束週期的快照」的稽核軌跡；且 `--query` 欄位名打錯時
  CLI 靜默回 `null` 且 exit 0，`run()` 完全接不住。digest 判斷錯了改 jq 重跑即可，原始證據永遠保留。
- **直譯器只處理本機資料**：`python3` / `awk` / `sed` 等只用於處理 `data/` 本機檔案；嚴禁透過任何直譯器、管線或子程序間接呼叫會變更 AWS 帳號狀態的指令（deny 清單是字串比對，直譯器會繞過，故此條以指令層規範補上死角）
- `data/` 含帳號內部資訊，已列入 .gitignore，不得提交或外傳
- 報告為正式上線用途，**預設不遮罩**帳號 ID 等資訊；僅在使用者明確要求對外分享版時才產生遮罩版（`build-report.js --masked` 會做遮罩防呆檢查）

## 執行流程（三階段）

一鍵無人值守請用 `/report-aws <期別>`（見 `.claude/skills/report-aws/SKILL.md`），會依下列流程不中途停頓跑完全程、結束才回報；憑證失效時在階段 0 快速失敗。手動逐段執行時流程相同：

```
① aws-scanner（同步執行）
     掃描 → data/*.json + data/inventory.md（一次性 list/describe 服務由 scan-catalog(.local).json 宣告）
     scan.sh 末尾自動跑 digest.sh → data/digest/（精簡投影＋network-facts 跨檔事實表＋coverage 服務覆蓋率自檢）
② 四個分析 agent（並行背景執行，等 ① 完成後才派工）
     security-auditor / reliability-reviewer / performance-reviewer / cost-optimizer
     各自輸出 findings/<pillar>.md
③ report-writer（等 ② 全部完成後才派工）
     彙整 → report/AWS架構報告.md + report/report-data.json（HTML 報告的結構化資料）
④ 主對話執行確定性產生器（不經過 LLM，版型逐月固定）
     node .claude/skills/report-aws/scripts/build-report.js → report/aws-report.html
⑤ 主對話執行連結檢查（不經過 LLM，不碰 AWS 帳號）
     bash .claude/skills/report-aws/scripts/check-links.sh report/AWS架構報告.md findings/*.md
⑥ 主對話存檔本期報告
     bash .claude/skills/report-aws/scripts/archive-report.sh → archive/<期別>/
```

HTML 版型、配色、章節結構凍結在 `.claude/skills/report-aws/templates/report.html.template` 與
`.claude/skills/report-aws/templates/themes/*.css`，**不要每月重新設計**；逐月只換 report-data.json 的資料。
資料欄位規格見 `.claude/skills/report-aws/templates/report-data.spec.md`。換專案配色時新增
`.claude/skills/report-aws/templates/themes/<專案>.css` 並以 `--theme` 指定，版型不動。

各 agent 依工作性質分級指定模型（frontmatter `model:` 欄位，用別名以免模型改版逐檔改）：
scanner 走 `haiku`（純機械掃描）；performance-reviewer / cost-optimizer 走 `sonnet`（規則比對、數字核對）；
security-auditor / reliability-reviewer / report-writer 走 `opus`（風險判斷與綜合寫作，品質優先）。

前置條件：AWS 憑證有效（`aws sts get-caller-identity` 通過）。失效時請使用者更新，不要代為處理憑證。

備註：報告產到本機檔案為止，**無人值守流程不自動發佈 Artifact**（報告預設不遮罩、含帳號 ID）；
要發佈是使用者事後另外指定的動作。另，`dontAsk` 下**改不動 `.claude/` 底下的檔案**——
Edit/Write 一律被拒，補 allow 條目也沒用（這與「新增腳本要同步加 allow」是兩件事：
allow 管的是「能不能執行」，不管「能不能改 `.claude/` 裡的檔」）。要改 agent／skill／腳本本身時，
請使用者按 Shift+Tab 把當下 session 切成 acceptEdits，改完切回，不要去動 `settings.json` 的 `defaultMode`。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `.claude/agents/` | 六個 agent 定義 |
| `.claude/skills/report-aws/scripts/scan.sh` | 唯讀掃描腳本（scanner 執行；`REGIONS="..."` 可指定區域略過自動偵測）。核心掃描與明細迴圈寫死於此；「一次性 list/describe」服務改由 catalog 宣告（`run_from_catalog` 驅動） |
| `.claude/skills/report-aws/scripts/scan-catalog.json` | 掃描 catalog 基線（**進版控**）：宣告式列出要掃的一次性 list/describe 服務。加服務＝加一條 JSON，不改腳本 |
| `scan-catalog.local.json`（專案根目錄） | 掃描 catalog 的 per-project 補充（**gitignored**）：放「這個帳號」要加的必掃服務；在專案根目錄故 dontAsk 下也能自由編輯 |
| `.claude/skills/report-aws/scripts/digest.sh` | 掃描資料精簡（本機 jq，scan.sh 末尾自動呼叫；含證據欄位斷言） |
| `.claude/skills/report-aws/scripts/network-facts.py` | 跨檔關聯（子網實際路由／命名落差／RDS 落點）——確定性計算，不交給 LLM 判斷 |
| `.claude/skills/report-aws/scripts/coverage.py` | 服務覆蓋率自檢（Cost Explorer ∪ Tagging API 的 ARN diff scan.sh 的 run()）——digest.sh 末尾呼叫，產 data/digest/coverage.md，標出「帳號有用卻沒掃到」的缺口；預設回 0 不中斷流程，`COVERAGE_STRICT=1` 才把缺口當閘門 |
| `.claude/skills/report-aws/scripts/archive-report.sh` | 存檔本期報告到 archive/<期別>/（放頂層，不放 report/ 底下——清報告時會一起毀掉） |
| `.claude/skills/report-aws/scripts/check-links.sh` | 官方文件連結有效性檢查（確定性，8 路平行；不碰 AWS 帳號） |
| `.claude/skills/report-aws/scripts/build-report.js` | 確定性 HTML 產生器（report-data.json＋模板→HTML；schema 契約見 spec） |
| `.claude/skills/report-aws/scripts/hook-aws-literal-guard.sh` | PreToolUse hook：機制化攔截含展開的 aws 指令 |
| `.claude/skills/report-aws/references/aws-docs-*.md` | 已驗證的官方文件連結目錄，依支柱拆分——各 agent 只讀自己那份（common 檔含使用規則） |
| `.claude/skills/report-aws/templates/finding-format.md` | 發現統一格式——agent 之間的檔案介面，改動需同步引用它的五個 agent（aws-scanner 不產 findings，不引用） |
| `.claude/skills/report-aws/templates/report-data.spec.md` | report-data.json 的完整契約（含必填與驗證規則）——即完整規格，不需讀 build-report.js |
| `.claude/skills/aws-diagram/` | 獨立選配 skill：data/ 掃描產物 → draw.io 架構圖（確定性產生，不讓 LLM 手畫 XML）。依賴 report-aws 的資料佈局，**不在無人值守流程內**，想到才跑 `/aws-diagram` |
| `.githooks/pre-commit` | 擋下 `data/`／`report/`／`archive/`／`tmp/` 誤 commit（含 `git add -f` 繞過 .gitignore 的情況）。**每台機器需執行一次** `git config core.hooksPath .githooks` 才會生效 |
| `data/` | 掃描原始資料（gitignore） |
| `data/digest/` | 原始資料的確定性投影，agent 的預設讀取來源（gitignore） |
| `findings/` | 各支柱分析結果 |
| `report/` | 最終報告 |

## 慣例

- **`aws` 指令必須是字面量**（約束對象：agent 在 Bash **臨場輸入**的指令；版控內經審查的固定腳本
  如 scan.sh 不在此限——其動詞是寫死的唯讀字面量，變數只出現在參數位）：不得含 `$變數`、`$(...)`、
  迴圈或萬用字元——deny 清單靠字串比對，展開會讓它失明。需要值就先讀出來、直接寫進指令。
  此規則已由 PreToolUse hook（`hook-aws-literal-guard.sh`）**機制化強制**，不再只靠 prompt 服從。
  hook 生效前提是 session 從專案根目錄啟動；懷疑 hook 沒作用時，可手動組 PreToolUse 事件 JSON
  呼叫 `bash .claude/skills/report-aws/scripts/hook-aws-literal-guard.sh`，確認含展開字元的輸入會回傳 exit code 2。
  本機資料處理（jq/python3/awk 對 `data/` 檔案）不受此限：權限模式已是 `dontAsk` 不會跳提示，
  且唯讀保證由 IAM 唯讀憑證在帳號側強制。**大檔只需少數欄位時優先用 jq 過濾而非 Read 整檔**
  （Read 一次拉整份數千字元，四支柱平行時同檔重複計費）。
- **加「一次性 list/describe」服務改 catalog、不改腳本**：要新增一個單發掃描（如 Kinesis/SES）時，
  在 `scan-catalog.json`（版控基線）或專案根目錄 `scan-catalog.local.json`（gitignored、per-project）
  加一條 `{scope, service, command, output, args?}` 即可，`scan.sh` 的 `run_from_catalog` 會自動跑。
  **降低改壞腳本的風險、也讓 dontAsk 下能自由加服務**（local 檔不在 `.claude/`）。護欄：`command` 僅允許
  `describe-*`/`list-*`/`get-*`、禁 `--query`，違者掃描時 `REJECTED` 且不執行（IAM 唯讀憑證仍是最終防線）。
  「先 list 再逐一 describe」的明細迴圈與核心掃描仍寫死在 scan.sh（有 per-resource 邏輯，不進 catalog）。
  coverage.py 以「scan.sh 的 run() ∪ 兩份 catalog」為權威已掃清單，故服務搬進 catalog 不會被誤判成缺口。
- **空回應 ≠ 資料缺口**：AWS 對「未設定」的組態常回空輸出（0 位元組檔），例如帳號沒有 Budget、
  bucket 從未啟用版本控制。這是**有效證據**，可直接下發現。`data/digest/scan-gaps.md` 已把
  「空回應＝未設定」與「查詢失敗＝資料缺口」分清楚——agent 看到查不到的東西先讀它，
  不要自己回頭呼叫 AWS 補查（那正是觸發權限確認的來源）。
- **機械性的跨檔比對交給腳本，不要交給 LLM 判斷**：像「RDS 落在公有還是私有子網」這種要同時看
  三個檔才看得出來的關聯，一律在 `.claude/skills/report-aws/scripts/network-facts.py` 算成事實表，agent 讀結論。
  LLM 會忘、會隨機——2026-07 就因為漏做這一步，把 [高]「RDS 落在全部通 IGW 的公有子網」
  降級成 [中]「RDS 可公開存取」，還給出該帳號做不到的修復建議。
- **寫完要自我複查、不讀回、修訂用 Edit**：`Write` 成功即已寫入，內容還在 context 裡，
  再 `Read` 一次是重複計費；但**自我複查那一輪不能省**——逐條對照檢查重點，有遺漏用 `Edit` 補。
  （原本的「Write → Read 回自己的檔 → Write 整份重寫」雖然浪費約 9 萬輸出 token，
  但那第二輪正是補上跨檔分析的地方；只拿掉讀回與整份重寫，複查要留著。）
- 發現編號：SEC- / REL- / PERF- / COST- + 流水號，全流程保留不改編
- 嚴重度：高／中／低，定義見 `.claude/skills/report-aws/templates/finding-format.md`
- 報告語言：繁體中文，AWS 服務名稱保留英文
- 建議必須附 AWS 官方文件連結（Well-Architected 白皮書、服務文件、Prescriptive Guidance）
- **連結一律取自 `.claude/skills/report-aws/references/aws-docs-<支柱>.md`**（依支柱拆分，各 agent 只讀自己那份），不要為了確認連結有效而 WebFetch 整頁文件。
  `docs.aws.amazon.com` 是 SPA，**失效頁面仍回 HTTP 200**、只回約 1.2KB 空殼，
  靠 WebFetch 目視判斷會漏掉死連結（曾因此讓 3 個死連結進入已交付的報告）。
  有效性一律用 `bash .claude/skills/report-aws/scripts/check-links.sh` 檢查；目錄未涵蓋的主題才 WebFetch，查完把新連結補回**對應支柱的檔案**。例外：成本金額估算需要當下單價時，仍應 WebFetch 定價頁。

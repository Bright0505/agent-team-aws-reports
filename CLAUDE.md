# AWS 架構報告 Agent Team

依 AWS Well-Architected Framework 四大支柱（安全性、可靠性、效能效率、成本最佳化），
以唯讀掃描實際 AWS 帳號為依據，產出繁體中文架構報告（Markdown + HTML）。

## 鐵則

- **對 AWS 帳號全程唯讀**：只允許 `describe-*` / `list-*` / `get-*` 類 API，任何 agent 都不得執行變更帳號狀態的指令
- **精簡只在本機做，不在擷取端做**：`scan.sh` 一律抓完整 JSON，精簡交給 `digest.sh`（本機 jq）。
  不要改用 AWS CLI 的 `--query` 裁切——那是「擷取時破壞、不可逆」，欄位判斷錯了只能重掃帳號，
  而重掃時帳號狀態已變，會破壞報告「期別＝已結束週期的快照」的稽核軌跡；且 `--query` 欄位名打錯時
  CLI 靜默回 `null` 且 exit 0，`run()` 完全接不住。digest 判斷錯了改 jq 重跑即可，原始證據永遠保留。
- **直譯器只處理本機資料**：`python3` / `awk` / `sed` 等只用於處理 `data/` 本機檔案；嚴禁透過任何直譯器、管線或子程序間接呼叫會變更 AWS 帳號狀態的指令（deny 清單是字串比對，直譯器會繞過，故此條以指令層規範補上死角）
- `data/` 含帳號內部資訊，已列入 .gitignore，不得提交或外傳
- 報告為正式上線用途，**預設不遮罩**帳號 ID 等資訊；僅在使用者明確要求對外分享版時才產生遮罩版（`build-report.js --masked` 會做遮罩防呆檢查）

## 執行流程（三階段）

一鍵無人值守請用 `/report-aws <期別>`（見 `.claude/commands/report-aws.md`），會依下列流程不中途停頓跑完全程、結束才回報；憑證失效時在階段 0 快速失敗。手動逐段執行時流程相同：

```
① aws-scanner（同步執行）
     掃描 → data/*.json + data/inventory.md
     scan.sh 末尾自動跑 digest.sh → data/digest/（樣板欄位多的檔案的精簡投影）
② 四個分析 agent（並行背景執行，等 ① 完成後才派工）
     security-auditor / reliability-reviewer / performance-reviewer / cost-optimizer
     各自輸出 findings/<pillar>.md
③ report-writer（等 ② 全部完成後才派工）
     彙整 → report/AWS架構報告.md + report/report-data.json（HTML 報告的結構化資料）
④ 主對話執行確定性產生器（不經過 LLM，版型逐月固定）
     node scripts/build-report.js → report/aws-report.html → 發佈 Artifact
⑤ 主對話執行連結檢查（不經過 LLM，不碰 AWS 帳號）
     bash scripts/check-links.sh report/AWS架構報告.md findings/*.md
⑥ 主對話存檔本期報告
     bash scripts/archive-report.sh → archive/<期別>/
```

HTML 版型、配色、章節結構凍結在 `templates/report.html.template` 與
`templates/themes/*.css`，**不要每月重新設計**；逐月只換 report-data.json 的資料。
資料欄位規格見 `templates/report-data.spec.md`。換專案配色時新增
`templates/themes/<專案>.css` 並以 `--theme` 指定，版型不動。

各 agent 依工作性質分級指定模型（frontmatter `model:` 欄位，用別名以免模型改版逐檔改）：
scanner 走 `haiku`（純機械掃描）；performance-reviewer / cost-optimizer 走 `sonnet`（規則比對、數字核對）；
security-auditor / reliability-reviewer / report-writer 走 `opus`（風險判斷與綜合寫作，品質優先）。

前置條件：AWS 憑證有效（`aws sts get-caller-identity` 通過）。失效時請使用者更新，不要代為處理憑證。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `.claude/agents/` | 六個 agent 定義 |
| `scripts/scan.sh` | 唯讀掃描腳本（scanner 執行；`REGIONS="..."` 可指定區域略過自動偵測） |
| `scripts/digest.sh` | 掃描資料精簡（本機 jq，scan.sh 末尾自動呼叫；含證據欄位斷言） |
| `scripts/network-facts.py` | 跨檔關聯（子網實際路由／命名落差／RDS 落點）——確定性計算，不交給 LLM 判斷 |
| `scripts/archive-report.sh` | 存檔本期報告到 archive/<期別>/（放頂層，不放 report/ 底下——清報告時會一起毀掉） |
| `scripts/check-links.sh` | 官方文件連結有效性檢查（確定性，不經過 LLM；不碰 AWS 帳號） |
| `references/aws-docs.md` | 已驗證的 AWS 官方文件連結目錄——四大支柱 agent 的引用來源 |
| `templates/finding-format.md` | 發現統一格式——agent 之間的檔案介面，改動需同步六個 agent |
| `templates/report-data.spec.md` | report-data.json 的完整契約（含必填與驗證規則）——即完整規格，不需讀 build-report.js |
| `data/` | 掃描原始資料（gitignore） |
| `data/digest/` | 原始資料的確定性投影，agent 的預設讀取來源（gitignore） |
| `findings/` | 各支柱分析結果 |
| `report/` | 最終報告 |

## 慣例

- **Bash 指令不得含 shell 展開**：`for` 迴圈、`*` 萬用字元、`$(...)`、`$變數` 一律禁止。
  Claude Code 的 Bash 權限是字串比對，含展開就無法靜態驗證，**必定跳權限確認、破壞無人值守，
  且沒有任何白名單能放行**（`cat` 早在 allowlist 裡也擋不住）。需要帳號 ID 之類的值時，
  先 Read 出來再把值直接填進指令，不要 `$(...)` 動態取。
- **空回應 ≠ 資料缺口**：AWS 對「未設定」的組態常回空輸出（0 位元組檔），例如帳號沒有 Budget、
  bucket 從未啟用版本控制。這是**有效證據**，可直接下發現。`data/digest/scan-gaps.md` 已把
  「空回應＝未設定」與「查詢失敗＝資料缺口」分清楚——agent 看到查不到的東西先讀它，
  不要自己回頭呼叫 AWS 補查（那正是觸發權限確認的來源）。
- **機械性的跨檔比對交給腳本，不要交給 LLM 判斷**：像「RDS 落在公有還是私有子網」這種要同時看
  三個檔才看得出來的關聯，一律在 `scripts/network-facts.py` 算成事實表，agent 讀結論。
  LLM 會忘、會隨機——2026-07 就因為漏做這一步，把 [高]「RDS 落在全部通 IGW 的公有子網」
  降級成 [中]「RDS 可公開存取」，還給出該帳號做不到的修復建議。
- **寫完要自我複查、不讀回、修訂用 Edit**：`Write` 成功即已寫入，內容還在 context 裡，
  再 `Read` 一次是重複計費；但**自我複查那一輪不能省**——逐條對照檢查重點，有遺漏用 `Edit` 補。
  （原本的「Write → Read 回自己的檔 → Write 整份重寫」雖然浪費約 9 萬輸出 token，
  但那第二輪正是補上跨檔分析的地方；只拿掉讀回與整份重寫，複查要留著。）
- 發現編號：SEC- / REL- / PERF- / COST- + 流水號，全流程保留不改編
- 嚴重度：高／中／低，定義見 `templates/finding-format.md`
- 報告語言：繁體中文，AWS 服務名稱保留英文
- 建議必須附 AWS 官方文件連結（Well-Architected 白皮書、服務文件、Prescriptive Guidance）
- **連結一律取自 `references/aws-docs.md`**，不要為了確認連結有效而 WebFetch 整頁文件。
  `docs.aws.amazon.com` 是 SPA，**失效頁面仍回 HTTP 200**、只回約 1.2KB 空殼，
  靠 WebFetch 目視判斷會漏掉死連結（曾因此讓 3 個死連結進入已交付的報告）。
  有效性一律用 `bash scripts/check-links.sh` 檢查；目錄未涵蓋的主題才 WebFetch，
  查完把新連結補回目錄。例外：成本金額估算需要當下單價時，仍應 WebFetch 定價頁。

---
description: 一鍵無人值守產出 AWS 架構報告（scan → 四支柱並行 → 彙整 → HTML），中途不停、結束才回報
argument-hint: "[期別，如 2026-07 或 2026-Q3；留空用當月]"
---

你現在要**以無人值守方式**跑完整條 AWS 架構報告流程。使用者已透過 `/report-aws` 明確授權，
從現在起**一路跑到產出 HTML 報告為止，中途一律不得停下來問使用者或等待確認**——
唯一的例外是「階段 0 憑證檢查」失敗。全程結束後才回報一則摘要。

期別參數：`$ARGUMENTS`

**一句話：期別只決定「成本」看哪個週期，其餘一律是掃描當下的快照。**

- 期別＝一個**已結束的完整週期**，慣例在週期結束後才觸發：
  `2026-06` 月報＝6 月整月、`2026-Q2` 季報＝4–6 月、`2025` 年報＝整個 2025；
  **留空＝上一個完整月**（例：7/5 觸發即 6 月）。用於報告 `meta.title`。
- **只有成本**跟著期別：成本窗＝主體週期＋前 N 期趨勢（月報＋前 2 月、季報＋前 1 季、年報＋前 1 年，
  皆 MONTHLY；季報／年報的前 N 為暫定值，定義在 `scripts/scan.sh` 的 `SPAN`/`TREND_PRIOR`）。
- **資源盤點、安全性、可靠性、效能指標一律為掃描當下的快照，不受期別影響**（AWS 只給現況，
  沒有「某月的安全狀態」可查）。掃描日期一律用今天。

## 鐵則（本次執行全程適用）

- **全程對 AWS 帳號唯讀**：只允許 `describe-*` / `list-*` / `get-*` 類 API，絕不執行任何變更帳號狀態的指令。
- **直譯器只處理本機資料**：`python3` / `awk` / `sed` 等僅供處理 `data/` 本機檔案；
  **嚴禁透過任何直譯器、管線或子程序間接呼叫會變更 AWS 帳號狀態的指令**。
- **中途不問人**：每階段之間不等待人工確認，直接接續下一階段；除階段 0 憑證失敗外不得中止詢問。
- 報告**預設不遮罩**（正式上線用途）；不自動發佈 Artifact，無人值守路徑到本機檔案為止。

## 階段 0 — 前置憑證檢查（唯一的快速失敗點）

跑 `aws sts get-caller-identity`。

- **失敗**：**立刻停止整個流程**，不要派任何 agent、不要嘗試修復憑證。只回一句：
  「AWS 憑證失效或未登入，請先執行 `aws sso login`（或 `aws configure`）後重新 `/report-aws`。」然後結束。
- **成功**：記下 account/arn，直接進入階段 ①，不要停下來問使用者。

## 階段 ① — 掃描（同步，前景等待）

派 `aws-scanner`（同步執行、等它完成）跑 `scripts/scan.sh default <期別>`（把期別當**第二個位置參數**傳入，
成本趨勢窗才會依報告型別調整；期別留空則直接跑 `scripts/scan.sh` 用當月月報）掃描帳號。
用位置參數而非 `PERIOD=… scripts/scan.sh` 的 env 前綴，才吃得到 allowlist、無人值守不跳權限提示。
完成後確認 `data/inventory.md` 與 `data/scan-meta.json` 都存在；
若缺任一，停止並回報掃描失敗原因（讀 `data/scan-errors.log` 說明）。

## 階段 ② — 四支柱並行分析（背景並行）

**在同一則訊息裡並行派四個分析 agent**（背景執行），等四個都完成通知才進下一階段：

- `security-auditor` → `findings/security.md`
- `reliability-reviewer` → `findings/reliability.md`
- `performance-reviewer` → `findings/performance.md`
- `cost-optimizer` → `findings/cost.md`

四個都回報後，逐一確認對應 `findings/*.md` 存在。
若**某一支硬失敗**（完全無輸出檔）：**記錄該支柱缺漏、繼續用其餘支柱往下走**，
在最末摘要明確標註「缺 X 支柱」，不要因單一支柱失敗中止整批，也不要停下來問使用者。

## 階段 ③ — 彙整報告

四份 findings 齊全（或已確認哪些缺漏）後，派 `report-writer` 產出：
- `report/AWS架構報告.md`
- `report/report-data.json`

## 階段 ④ — 確定性產生 HTML（由你＝主對話執行）

report-writer 沒有 Bash，這步由你跑：

```
node scripts/build-report.js
```

- 成功 → 產出 `report/aws-report.html`，進入收尾。
- 若因 `report-data.json` 不合 schema 而 `exit 1`：讀取錯誤訊息，回頭請 `report-writer`
  只修正該欄位後**重跑一次** `build-report.js`（**最多重試一次**）。仍失敗才停止並回報錯誤細節。

## 收尾（唯一的回報時機）

輸出一則摘要：
- 期別、掃描帳號與區域、掃描日期
- 四支柱各自分數與各嚴重度（高／中／低）發現數；若有缺漏支柱明確標註
- 產出檔路徑：`report/aws-report.html`、`report/AWS架構報告.md`、`report/report-data.json`
- 提醒：如需對外分享版，可再要求 `node scripts/build-report.js --masked`（遮罩防呆）或發佈 Artifact

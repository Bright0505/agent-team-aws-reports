# AWS 架構報告 Agent Team

依 AWS Well-Architected Framework 四大支柱（安全性、可靠性、效能效率、成本最佳化），
以唯讀掃描實際 AWS 帳號為依據，產出繁體中文架構報告（Markdown + HTML）。

## 鐵則

- **對 AWS 帳號全程唯讀**：只允許 `describe-*` / `list-*` / `get-*` 類 API，任何 agent 都不得執行變更帳號狀態的指令
- `data/` 含帳號內部資訊，已列入 .gitignore，不得提交或外傳
- 發佈 HTML 報告（Artifact）前，先與使用者確認帳號 ID 等敏感資訊是否遮罩

## 執行流程（三階段）

```
① aws-scanner（同步執行）
     掃描 → data/*.json + data/inventory.md
② 四個分析 agent（並行背景執行，等 ① 完成後才派工）
     security-auditor / reliability-reviewer / performance-reviewer / cost-optimizer
     各自輸出 findings/<pillar>.md
③ report-writer（等 ② 全部完成後才派工）
     彙整 → report/AWS架構報告.md
   之後由主對話製作 HTML 報告頁（載入 artifact-design + dataviz skill）並發佈 Artifact
```

前置條件：AWS 憑證有效（`aws sts get-caller-identity` 通過）。失效時請使用者更新，不要代為處理憑證。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `.claude/agents/` | 六個 agent 定義 |
| `scripts/scan.sh` | 唯讀掃描腳本（scanner 執行；`REGIONS="..."` 可指定區域略過自動偵測） |
| `templates/finding-format.md` | 發現統一格式——agent 之間的檔案介面，改動需同步六個 agent |
| `data/` | 掃描原始資料（gitignore） |
| `findings/` | 各支柱分析結果 |
| `report/` | 最終報告 |

## 慣例

- 發現編號：SEC- / REL- / PERF- / COST- + 流水號，全流程保留不改編
- 嚴重度：高／中／低，定義見 `templates/finding-format.md`
- 報告語言：繁體中文，AWS 服務名稱保留英文
- 建議必須附 AWS 官方文件連結（Well-Architected 白皮書、服務文件、Prescriptive Guidance）

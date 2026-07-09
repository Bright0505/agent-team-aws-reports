# AWS 架構報告 Agent Team

以 Claude Code 多 agent 協作，對實際 AWS 帳號進行**全程唯讀**掃描，
依 [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/) 四大支柱
（安全性、可靠性、效能效率、成本最佳化）產出繁體中文架構報告（Markdown + HTML）。

## 特色

- **唯讀保證**：掃描只使用 `describe-*` / `list-*` / `get-*` 類 AWS API，不對帳號做任何變更
- **證據導向**：每項發現的現況證據必須對回 `data/` 內的實際掃描資料，不憑空推測
- **並行分析**：四大支柱由四個 agent 並行分析，最後由 report-writer 彙整
- **敏感資訊保護**：掃描原始資料（`data/`）已列入 `.gitignore`，只留本機；發佈 HTML 報告前會與使用者確認帳號 ID 等敏感資訊是否遮罩

## 前置條件

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) 與 `jq`
- 有效的 AWS 憑證（`aws sts get-caller-identity` 須通過），建議使用唯讀權限（如 `ReadOnlyAccess` 受管政策）
- [Claude Code](https://claude.com/claude-code)

## 使用方式

在 Claude Code 中直接要求產出架構報告即可，主對話會依下列三階段派工：

```
① aws-scanner（同步執行）
     執行 scripts/scan.sh → data/*.json + data/inventory.md
② 四個分析 agent（並行背景執行，等 ① 完成後才派工）
     security-auditor / reliability-reviewer / performance-reviewer / cost-optimizer
     各自輸出 findings/<pillar>.md
③ report-writer（等 ② 全部完成後才派工）
     彙整 → report/AWS架構報告.md
   之後由主對話製作 HTML 報告頁並發佈 Artifact
```

也可以手動先跑掃描：

```bash
scripts/scan.sh              # 使用 default profile，自動偵測使用中的區域
scripts/scan.sh my-profile   # 指定 AWS profile
REGIONS="ap-east-2 us-east-1" scripts/scan.sh   # 指定區域，略過自動偵測
```

權限不足或服務未啟用的項目會記錄到 `data/scan-errors.log` 並繼續執行，屬預期行為。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `.claude/agents/` | 六個 agent 定義 |
| `scripts/scan.sh` | 唯讀掃描腳本 |
| `templates/finding-format.md` | 發現統一格式——agent 之間的檔案介面 |
| `data/` | 掃描原始資料（gitignore，只留本機） |
| `findings/` | 各支柱分析結果（執行時產生） |
| `report/` | 最終報告（執行時產生） |
| `CLAUDE.md` | Claude Code 專案指示（鐵則與流程細節） |

## Agent 一覽

| Agent | 角色 |
|---|---|
| `aws-scanner` | 唯讀掃描 AWS 帳號，產出 `data/*.json` 與資源盤點摘要 `data/inventory.md` |
| `security-auditor` | 安全性支柱分析 → `findings/security.md`（SEC-xx） |
| `reliability-reviewer` | 可靠性支柱分析 → `findings/reliability.md`（REL-xx） |
| `performance-reviewer` | 效能效率支柱分析 → `findings/performance.md`（PERF-xx） |
| `cost-optimizer` | 成本最佳化支柱分析 → `findings/cost.md`（COST-xx） |
| `report-writer` | 彙整四大支柱發現 → `report/AWS架構報告.md` |

## 慣例

- **發現編號**：`SEC-` / `REL-` / `PERF-` / `COST-` + 流水號，全流程保留不改編
- **嚴重度**：高／中／低，定義見 `templates/finding-format.md`
- **報告語言**：繁體中文，AWS 服務名稱保留英文
- **參考文件**：建議必須附 AWS 官方文件連結（Well-Architected 白皮書、服務文件、Prescriptive Guidance）

## 安全注意事項

- `data/` 含帳號內部資訊，**不得提交或外傳**
- `findings/` 與 `report/` 會引用資源 ID／ARN，對外分享前請自行確認是否需要遮罩
- 憑證失效時請自行更新（`aws configure` 或 `aws sso login`），agent 不會代為處理憑證

# AWS 架構報告 Agent Team

以 Claude Code 多 agent 協作，對實際 AWS 帳號進行**全程唯讀**掃描，
依 [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/) 四大支柱
（安全性、可靠性、效能效率、成本最佳化）產出繁體中文架構報告（Markdown + HTML）。

## 特色

- **唯讀保證**：掃描只使用 `describe-*` / `list-*` / `get-*` 類 AWS API，不對帳號做任何變更
- **證據導向**：每項發現的現況證據必須對回 `data/` 內的實際掃描資料，不憑空推測
- **並行分析**：四大支柱由四個 agent 並行分析，最後由 report-writer 彙整
- **固定版型**：HTML 報告由確定性腳本從模板＋結構化資料產生，不經過 LLM，逐月版型、配色、章節結構完全一致
- **敏感資訊保護**：掃描原始資料（`data/`）已列入 `.gitignore`，只留本機；需要對外分享時可用 `--masked` 產生遮罩版報告

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
     彙整 → report/AWS架構報告.md + report/report-data.json
④ 確定性產生 HTML（不經過 LLM，版型逐月固定）
     node scripts/build-report.js → report/aws-report.html → 發佈 Artifact
```

也可以手動先跑掃描：

```bash
scripts/scan.sh              # 使用 default profile，自動偵測使用中的區域
scripts/scan.sh my-profile   # 指定 AWS profile
REGIONS="ap-east-2 us-east-1" scripts/scan.sh   # 指定區域，略過自動偵測
```

權限不足或服務未啟用的項目會記錄到 `data/scan-errors.log` 並繼續執行，屬預期行為。

HTML 報告產生器：

```bash
node scripts/build-report.js                # report-data.json + 模板 → report/aws-report.html
node scripts/build-report.js --standalone   # 包成完整 HTML 供本機直接開啟
node scripts/build-report.js --theme templates/themes/<專案>.css   # 換專案配色
node scripts/build-report.js --masked       # 對外分享版：啟用遮罩防呆檢查
```

版型與章節結構凍結在 `templates/report.html.template`；配色 token 抽在
`templates/themes/`，不同專案換主題檔即可。資料欄位規格見
`templates/report-data.spec.md`，完整範例見 `templates/report-data.example.json`。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `.claude/agents/` | 六個 agent 定義 |
| `scripts/scan.sh` | 唯讀掃描腳本 |
| `scripts/build-report.js` | 確定性 HTML 報告產生器（模板＋資料填充，不經過 LLM） |
| `templates/finding-format.md` | 發現統一格式——agent 之間的檔案介面 |
| `templates/report.html.template` | HTML 報告凍結模板（版型與章節結構） |
| `templates/themes/` | 報告配色 token（依專案抽換） |
| `templates/report-data.spec.md` | report-data.json 欄位規格 |
| `templates/report-data.example.json` | 資料檔完整範例（兼設計基準） |
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
- 報告預設不遮罩（正式上線用途）；對外分享前用 `build-report.js --masked` 產生遮罩版並通過防呆檢查
- 憑證失效時請自行更新（`aws configure` 或 `aws sso login`），agent 不會代為處理憑證

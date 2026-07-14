# AWS 官方文件連結目錄

四大支柱 agent 撰寫建議時的引用來源（背景說明與使用規則；連結本體依支柱拆在 `aws-docs-<支柱>.md`）。
**最後驗證：2026-07-13（75 個連結全數有效）**

## 為什麼有這個檔案

CLAUDE.md 規定「建議必須附 AWS 官方文件連結」。過去 agent 是用 WebFetch 逐頁抓取來確認連結，
這個做法有兩個問題：

1. **浪費**：把整頁文件（單頁最多 35K 字元）拉進 context 只為了確認連結能開，
   每個月重抓同樣的頁面。上一次執行光 WebFetch 就占了所有 agent 拉進 context 內容的 22%。
2. **沒防到呆**：`docs.aws.amazon.com` 是 SPA，不存在的頁面**仍回 HTTP 200**，
   WebFetch 只會拿到約 1.2KB 的空殼。上一次 security-auditor 抓了一個已失效的 root MFA 連結，
   拿到空殼卻仍把它寫進報告——實際上報告交付時有 3 個死連結。

因此改為：**連結由目錄檔提供（已驗證），有效性由 `.claude/skills/report-aws/scripts/check-links.sh` 確定性檢查**（不經過 LLM、不花 token）。

## 使用規則（四大支柱 agent）

- 引用官方文件時，**從自己支柱的 `aws-docs-<支柱>.md` 取用**，不要為了「確認連結有效」而 WebFetch。
- 目錄沒有涵蓋的主題，才用 WebFetch 查證；**查到後把新連結補進對應支柱的 `aws-docs-<支柱>.md`**，供下個月重複使用。
- 不確定某連結是否仍有效時，跑 `bash .claude/skills/report-aws/scripts/check-links.sh`，不要用 WebFetch 目視判斷
  （空殼頁面看起來像正常回應，目視判斷不可靠）。

---

## Well-Architected 白皮書（四大支柱進入點）

- [Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) — 安全性支柱總論
- [Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) — 可靠性支柱總論
- [Performance Efficiency Pillar](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html) — 效能效率支柱總論
- [Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html) — 成本最佳化支柱總論

## 依支柱拆分的目錄檔

| 檔案 | 給誰讀 |
|---|---|
| `aws-docs-sec.md` | security-auditor |
| `aws-docs-rel.md` | reliability-reviewer |
| `aws-docs-perf.md` | performance-reviewer |
| `aws-docs-cost.md` | cost-optimizer |

拆分原因：原本 14K 的單一檔被四個 agent 各整份讀一次（context 各自獨立＝付四次），
但每個 agent 只需要自己支柱那一段。拆分後各 agent 只讀自己的檔（3–6K）。
新連結補進**對應支柱的檔案**；`.claude/skills/report-aws/scripts/check-links.sh` 預設會檢查整個 `.claude/skills/report-aws/references/` 目錄。


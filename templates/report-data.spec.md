# report-data.json 規格

`report/report-data.json` 是 HTML 報告的唯一資料來源，由 report-writer 在產出
Markdown 主報告的同時一併輸出。之後由確定性腳本產生 HTML，**不經過任何 LLM**：

```bash
node scripts/build-report.js                # 讀 report/report-data.json → report/aws-report.html
node scripts/build-report.js --standalone   # 包成完整 HTML 供本機直接開啟
node scripts/build-report.js --theme templates/themes/<專案>.css   # 換專案主題
node scripts/build-report.js --masked       # 對外分享版：啟用遮罩防呆檢查
```

版型、配色、章節結構凍結在 `templates/report.html.template` 與
`templates/themes/*.css`，逐月只換本檔的資料。完整範例見
`templates/report-data.example.json`（可直接產出一份與設計基準一致的報告）。

## 遮罩原則

報告為正式上線用途，**預設不遮罩**：帳號 ID、資源 ID、網域名稱照實填寫。
僅在使用者明確要求對外分享版時才另外產生遮罩版資料，並以 `--masked` 建置——
此模式會對最終 HTML 做防呆掃描（12 位數字、`AKIA` 金鑰樣式），命中即中止不寫檔。

## 行內標記

字串欄位一律純文字，模板會 HTML escape。以下欄位額外支援有限標記
（先 escape 再轉換，可安全使用）：

- `**粗體**`：`meta.lede`、`cost.cap`、`roadmap[].items[]`、`method.items[]`、`method.gaps[]`
- `` `程式碼` ``：`method.items[]`、`method.gaps[]`（渲染為遮罩樣式的 code）

## 欄位定義

### meta

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 報告標題（h1 與網頁 title） |
| `eyebrow` | string? | 標題上方小字，預設「AWS Well-Architected · 基礎架構評估」 |
| `account` | string | 帳號識別（預設照實填；對外分享版才填遮罩值） |
| `regions` | string[] | 掃描區域，多個以「、」連接顯示 |
| `scan_date` | string | 掃描日期 YYYY-MM-DD（頁首與頁尾） |
| `lede` | string | 開頭導言（支援 `**粗體**`） |

### pillars — 恰好 4 個，順序固定

順序固定為 `security` → `reliability` → `performance` → `cost`，
中文名／英文名／編號前綴由腳本帶入，不需填。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | 支柱 id（見上） |
| `score` | int 1–5 | 支柱評分（pips 自動產生） |
| `high` / `medium` / `low` | int ≥0 | 發現統計數（01/02 章圖表依此繪製；合計自動加總） |
| `p_summary` | string? | 明細區開頭摘要 |
| `findings` | array | **要顯示在明細的發現**（可為統計數的子集，例如低風險只計數不列出） |
| `findings[].id` | string | `SEC-1`／`REL-2`… 需符合支柱前綴 |
| `findings[].severity` | string | `高`／`中`／`低` |
| `findings[].title` | string | 發現標題（成本項可將金額寫進標題） |
| `findings[].desc` | string? | 現況／證據一句話 |
| `findings[].rec` | string? | 建議做法（顯示時自動加「建議：」前綴） |
| `good_note` | string? | 良好實務一段話 |

驗證：各嚴重度「明細列出的筆數」不得超過統計數。

### priorities — 1–5 項（03 最優先處理）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 事項標題 |
| `desc` | string | 白話說明 |
| `tags` | string[] | 標籤；發現編號（如 `SEC-01`）會驗證必須存在於明細，其他字串（如 `約半天`）自由填 |

### cost（05 成本節省概覽）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `total_monthly` | number | 每月合計節省（hero 大字，自動加 `$` 與「／月」） |
| `cap` | string | hero 下方說明（支援 `**粗體**`） |
| `sub` | string | hero 註腳小字 |
| `items` | array | 各項節省，長條寬度依最大值自動歸一化 |
| `items[].label` | string | 項目名稱 |
| `items[].amount` | number | 每月金額（自動加 `$`） |

### roadmap — 恰好 3 欄（06 改善路線圖）

固定三欄：Quick Wins（紅頂）→ 中期（橙頂）→ 長期（強調色頂）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 欄標題 |
| `when` | string | 時間範圍小字 |
| `items` | string[] | 事項（支援 `**粗體**`） |

### method（07 掃描方法與資料缺口）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `items` | string[] | 掃描方法說明（支援 `**粗體**`、`` `code` ``） |
| `gaps` | string[] | 主要資料缺口 |

## 換專案主題

複製 `templates/themes/default.css` 為 `<專案>.css` 改色票即可；
只能改 token 值，不可改 selector 結構（深淺雙主題與 `data-theme`
覆蓋依賴它）。嚴重度三色（`--hi`／`--mid`／`--lo`）語意固定為
高=紅、中=橙、低=黃，不得對調。

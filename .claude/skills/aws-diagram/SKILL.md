---
name: aws-diagram
description: 把 /report-aws 的掃描產物（data/）確定性轉成 draw.io 架構圖（匯總頁＋總覽頁＋每 VPC 一頁，子網級拓撲）。選配功能，想到才跑，不在無人值守流程內。
---

把 `data/` 掃描資料轉成 draw.io 架構圖檔 `report/aws-architecture.drawio`。

**鐵則：架構圖由腳本確定性產生，不要讓 LLM 手畫或手改 drawio XML。**
同樣輸入必得同樣輸出，逐月重跑版面固定、diff 即拓撲變化；LLM 手畫必然漂移、漏資源。
版面調整需求一律改 `scripts/build-diagram.js` 檔頭的版面常數（`LAYOUT`）或樣式表（`STYLES`）
後重跑——不要在產出的 `.drawio` 上手改後期待重跑保留（重跑會整檔覆蓋）。

## 前置依賴（資料契約）

本 skill 依賴 `/report-aws` 的掃描產物檔案佈局，**全程只讀本機檔案，不碰 AWS 帳號**：

- `data/caller-identity.json`（帳號 ID 標籤）
- `data/regions/<區域>/`：`vpcs` / `subnets` / `route-tables` / `internet-gateways` /
  `load-balancers` / `target-groups` / `lb-listeners/` / `ecs-detail/` / `rds-instances` /
  `security-groups` / `vpc-endpoints` / `ec2-instances` / `nat-gateways` 等 JSON
- `data/global/`：`s3-buckets.json`、`route53-hosted-zones.json`
- `data/digest/cloudfront-distributions.json`（缺時退回 `data/global/` 同名檔）

腳本缺檔會明確報錯。**缺檔時請使用者先跑 `/report-aws`（或至少階段①掃描），
不要自行呼叫 AWS 補查**——那正是觸發權限確認的來源，且違反「期別快照」稽核軌跡。

## 執行步驟

1. 執行產生器（從專案根目錄）：
   ```
   node .claude/skills/aws-diagram/scripts/build-diagram.js
   ```
   選用 `--out <路徑>` 改輸出位置（預設 `report/aws-architecture.drawio`）。
2. 腳本 stdout 會印計數摘要（畫了幾個子網/ALB/ECS 服務/RDS/CloudFront/S3、產了幾頁），
   並內建「畫出數量 == 來源 JSON 數量」斷言，失敗即非零退出——把摘要轉述給使用者，
   可對照 `data/inventory.md` 覆核。
3. 提示使用者用 [app.diagrams.net](https://app.diagrams.net) 或 VS Code 的 Draw.io
   Integration 擴充開啟 `.drawio` 檔目視確認；之後要匯出 PNG/SVG 也在那裡做。
4. 使用者若要調版面（間距、配色、圖示、頁面切分），改 `build-diagram.js` 的
   `LAYOUT` / `STYLES` 常數重跑；若是資料判讀規則（例如新增一種流量邊），改對應的
   join 函式——邊一律只畫「可證明的 join」，證明不了就不畫、不猜。

## 產出結構

單一 `.drawio` 檔、多分頁（資料驅動，不寫死環境名）：

- 頁 1「匯總」：全帳號一張，給對外簡報用。雲外入口欄（使用者 → Route 53 → CloudFront）
  → AWS Cloud 框，框內左側是帳號層服務欄（CloudTrail / Config / GuardDuty / S3 / IAM，
  掃描檔為空者灰化標「未啟用」），右側 Region 框內每個 VPC 一個區塊：
  公有／私有兩條**背景通道**（綠／藍，全高），子網方塊堆在通道頂端（短名＋CIDR＋AZ），
  底下依序疊 ALB → ECS → EC2 → RDS 的資源列，每列外圈一個紅色 Security Group 框。
  **資源畫在哪條通道由其子網集合的實際路由決定**——跨層時畫成橫跨兩欄的橘框（含 ⚠），
  RDS 也不例外（子網群組全通 IGW 就畫在公有通道，不因「DB 理應在私有層」而美化）。
  IGW → ALB 的邊標由 SG 中 IpRanges 含 `0.0.0.0/0` 的埠集合算出（如 `allow 80,443 from 0.0.0.0/0`）。
  版面常數在 `SUM`，計數斷言自成一套（不與其他分頁的 `drawn` 混用）。
- 頁 2「總覽」：使用者 → CloudFront（標 alias；停用者灰化）→ 各 VPC 縮略框／S3。
  無工作負載的 VPC（如 default VPC）在此只有縮略框（但匯總頁仍會完整畫出其子網）。
- 頁 3..N：每個「有工作負載（ALB/ECS/RDS/EC2 任一）」的 VPC 一頁——
  IGW → ALB 帶 → ECS cluster 帶 → RDS 帶的流量鏈（邊標 port），
  下方是子網格（AZ × 公/私分層，**依實際路由分層**，不看命名）。
- 警示標記為確定性規則（不讀 findings/）：子網命名含 private 但實際通 IGW → 紅框⚠；
  RDS `PubliclyAccessible=true`／DB subnet group 含公有子網 → ⚠；
  ECS 工作負載子網跨公私層 → 橘框⚠；CloudFront 停用 → 灰化。

`report/` 會被下一輪報告流程覆蓋；本期定稿後由 report-aws 的 `archive-report.sh`
一併存到 `archive/<期別>/`。

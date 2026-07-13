# AWS 官方文件連結目錄

四大支柱 agent 撰寫建議時的引用來源。**最後驗證：2026-07-13（69 個連結全數有效）**

## 為什麼有這個檔案

CLAUDE.md 規定「建議必須附 AWS 官方文件連結」。過去 agent 是用 WebFetch 逐頁抓取來確認連結，
這個做法有兩個問題：

1. **浪費**：把整頁文件（單頁最多 35K 字元）拉進 context 只為了確認連結能開，
   每個月重抓同樣的頁面。上一次執行光 WebFetch 就占了所有 agent 拉進 context 內容的 22%。
2. **沒防到呆**：`docs.aws.amazon.com` 是 SPA，不存在的頁面**仍回 HTTP 200**，
   WebFetch 只會拿到約 1.2KB 的空殼。上一次 security-auditor 抓了一個已失效的 root MFA 連結，
   拿到空殼卻仍把它寫進報告——實際上報告交付時有 3 個死連結。

因此改為：**連結由本檔提供（已驗證），有效性由 `scripts/check-links.sh` 確定性檢查**（不經過 LLM、不花 token）。

## 使用規則（四大支柱 agent）

- 引用官方文件時，**優先從本檔取用**，不要為了「確認連結有效」而 WebFetch。
- 本檔沒有涵蓋的主題，才用 WebFetch 查證；**查到後把新連結補進本檔對應的支柱段落**，供下個月重複使用。
- 不確定某連結是否仍有效時，跑 `bash scripts/check-links.sh`，不要用 WebFetch 目視判斷
  （空殼頁面看起來像正常回應，目視判斷不可靠）。

---

## Well-Architected 白皮書（四大支柱進入點）

- [Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) — 安全性支柱總論
- [Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) — 可靠性支柱總論
- [Performance Efficiency Pillar](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html) — 效能效率支柱總論
- [Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html) — 成本最佳化支柱總論

---

## 安全性（SEC）

### 身分與存取（IAM）

- [Security best practices in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) — IAM 最佳實務總表，長期憑證改用 Role 的依據
- [Multi-factor authentication for AWS account root user](https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html) — root 帳號 MFA（注意：舊網址 `id_root-user-mfa.html` 已失效）
- [Set an account password policy for IAM users](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_passwords_account-policy.html) — 密碼政策強度
- [Update access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html) — Access Key 輪替（> 90 天的處理）
- [What is IAM Identity Center?](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html) — 以 Identity Center 取代 IAM 使用者長期憑證
- [Security Hub CSPM controls for IAM](https://docs.aws.amazon.com/securityhub/latest/userguide/iam-controls.html) — IAM 控制項對照

### 偵測控制

- [Security best practices in AWS CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html) — CloudTrail 日誌加密與驗證
- [Creating a trail for your AWS account](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-and-update-a-trail.html) — 建立 trail
- [Understanding multi-Region trails](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-multi-region-trails.html) — 多區域 trail
- [What is Amazon GuardDuty?](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html) — GuardDuty 啟用建議
- [What Is AWS Config?](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html) — Config 組態稽核
- [AWS Foundational Security Best Practices standard](https://docs.aws.amazon.com/securityhub/latest/userguide/fsbp-standard.html) — FSBP 標準（發現的對照基準）
- [Logging IP traffic using VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html) — VPC Flow Logs

### 基礎設施保護

- [Protecting networks](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/protecting-networks.html) — 網路防護（Security Group 對 0.0.0.0/0 開放的依據）
- [Control subnet traffic with network ACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html) — NACL 設定
- [Example: VPC with servers in private subnets and NAT](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-example-private-subnets-nat.html) — 公私子網分離的參考架構
- [Restrict access to Application Load Balancers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html) — 防止 ALB 被直連繞過 CloudFront/WAF
- [Restrict access with VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html) — VPC origin 收斂 ALB 曝露面
- [Working with a DB instance in a VPC](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html) — RDS 網路隔離
- [Security Hub CSPM controls for RDS](https://docs.aws.amazon.com/securityhub/latest/userguide/rds-controls.html) — RDS 控制項對照

### 資料保護

- [Blocking public access to your Amazon S3 storage](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html) — S3 Public Access Block
- [Restrict access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html) — 以 OAC 取代 S3 website endpoint
- [Security Hub CSPM controls for S3](https://docs.aws.amazon.com/securityhub/latest/userguide/s3-controls.html) — S3 控制項對照
- [Create an HTTPS listener for your ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html) — ALB 補 443 監聽器
- [Security policies for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html) — ALB TLS 政策版本
- [IAM database authentication for RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html) — 以 IAM 認證取代資料庫密碼

---

## 可靠性（REL）

- [Plan your network topology](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-your-network-topology.html) — 多 AZ 網路拓撲
- [Use fault isolation to protect your workload](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/use-fault-isolation-to-protect-your-workload.html) — 故障隔離（單點故障 SPOF 的依據）
- [Change management](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/change-management.html) — 需求變化與自動擴展（注意：舊網址 `manage-demand-and-supply-resources.html` 已失效）
- [Back up data](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/back-up-data.html) — 備份策略
- [Plan for Disaster Recovery (DR)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-for-disaster-recovery-dr.html) — DR 規劃
- [Monitor workload resources](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/monitor-workload-resources.html) — 監控覆蓋
- [Introduction to backups (RDS)](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html) — RDS 備份保留天數
- [Creating backup copies across AWS Regions](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html) — 跨區域備份
- [Working with Amazon RDS event notification](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.html) — RDS 事件告警
- [Retaining multiple versions of objects with S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) — S3 版本控制
- [Using Amazon CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html) — 告警需有 SNS 動作，非空告警
- [Health checks for ALB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html) — target group 健康檢查
- [Application Load Balancers（deletion protection）](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#deletion-protection) — ALB 刪除保護
- [Optimize high availability with CloudFront origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html) — CloudFront origin 容錯移轉
- [Creating Amazon Route 53 health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover.html) — DNS 層 failover
- [Automatically scale your Amazon ECS service](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html) — ECS 服務自動擴展
- [How CloudWatch alarms detect ECS deployment failures](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-alarm-failure.html) — ECS 部署失敗偵測
- [Task retirement and maintenance for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html) — Fargate 任務汰換
- [Amazon ECS services](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html) — ECS service 概念
- [Amazon ECS service definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html) — ECS service 參數

---

## 效能效率（PERF）

- [Process and culture](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/process-and-culture.html) — 以指標監控驗證效能（注意：舊網址 `monitoring-your-resources-to-verify-performance.html` 已失效）
- [Use managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html) — CloudFront 快取政策
- [All distribution settings reference（HTTP version）](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesHTTPVersion) — HTTP/2、HTTP/3 啟用
- [Use various origins with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistS3AndCustomOrigins.html#concept_CustomOrigin) — custom origin 設定（OriginProtocolPolicy）
- [Generate custom error responses](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html) — 自訂錯誤頁
- [Listener rules for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-rules.html) — ALB 路由規則
- [DB instance classes（Graviton2）](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html#Concepts.DBInstanceClass.Graviton2) — RDS 機型世代升級
- [Upgrading a DB instance engine version](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.Upgrading.html) — RDS 引擎版本升級
- [Fargate platform versions for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/platform_versions.html) — Fargate 平台版本
- [Amazon ECS task networking options for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html) — Fargate 網路模式
- [Amazon ECR interface VPC endpoints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html) — ECR VPC Endpoint（降延遲、省 NAT）
- [Choosing Fargate task sizes for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-size-best-practice.html) — Fargate 任務 CPU/記憶體規格選擇
- [Best practices for Amazon ECS task sizes](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/fargate-task-size.html) — 任務規格與負載匹配的最佳實務
- [Amazon ECS task definitions for 64-bit ARM workloads](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-arm64.html) — Fargate/ECS 改用 ARM64（Graviton）

---

## 成本最佳化（COST）

- [Managing your costs with AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) — Budgets 告警
- [Detecting unusual spend with AWS Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html) — 成本異常偵測
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html) — Savings Plans 適用性
- [Reserved DB instances for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithReservedDBInstances.html) — RDS 預留執行個體
- [Managing the lifecycle of objects（S3）](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) — S3 生命週期轉 IA / Glacier
- [Working with log groups and log streams](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html) — Log Group 保留期限（「永不過期」的成本）
- [New – AWS Public IPv4 Address Charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/) — 公有 IPv4 收費（未關聯 EIP 的依據）

### 定價頁（金額估算用；價格會變動，估算時以當下頁面為準）

- [AWS WAF 定價](https://aws.amazon.com/waf/pricing/) — Web ACL 固定月費
- [Elastic Load Balancing 定價](https://aws.amazon.com/elasticloadbalancing/pricing/) — ALB 小時費與 LCU
- [Amazon CloudFront 定價](https://aws.amazon.com/cloudfront/pricing/) — 流量與請求費用
- [Amazon RDS for PostgreSQL 定價](https://aws.amazon.com/rds/postgresql/pricing/) — On-Demand／Reserved Instance 入口（注意：逐時費率為動態載入，需搭配 Pricing Calculator 核實）

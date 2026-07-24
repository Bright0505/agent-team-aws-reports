# AWS 官方文件連結目錄 — 成本最佳化（COST）

cost-optimizer 的引用來源（依支柱拆分，只讀這一份即可；使用規則與背景見 `references/aws-docs-common.md`）。最後驗證：2026-07-24。

- [Cost Optimization Pillar 白皮書](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html) — 本支柱進入點

## 成本最佳化（COST）

- [Managing your costs with AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) — Budgets 告警
- [Detecting unusual spend with AWS Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html) — 成本異常偵測
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html) — Savings Plans 適用性
- [Reserved DB instances for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithReservedDBInstances.html) — RDS 預留執行個體
- [DB instance class types](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Types.html) — RDS Graviton（T4g/M6g 等）執行個體類別
- [Amazon RDS now supports T4g instances for MySQL, MariaDB, and PostgreSQL](https://aws.amazon.com/about-aws/whats-new/2021/09/amazon-rds-t4g-mysql-mariadb-postgresql/) — T4g 對比 T3 最高 36% 價格效能提升（官方公告，PostgreSQL 12.5+ 支援）
- [Managing the lifecycle of objects（S3）](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) — S3 生命週期轉 IA / Glacier
- [Working with log groups and log streams](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html) — Log Group 保留期限（「永不過期」的成本）
- [New – AWS Public IPv4 Address Charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/) — 公有 IPv4 收費（未關聯 EIP 的依據）
- [Amazon ECR lifecycle policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html) — ECR 生命週期清舊映像，避免無限堆積計費
- [Amazon ElastiCache 定價（含 Reserved Node）](https://aws.amazon.com/elasticache/pricing/) — ElastiCache 預留節點與節點費率
- [Purchasing a reserved node (Redshift)](https://docs.aws.amazon.com/redshift/latest/mgmt/purchase-reserved-node-instance.html) — Redshift 預留節點
- [EFS lifecycle management](https://docs.aws.amazon.com/efs/latest/ug/lifecycle-management-efs.html) — EFS 冷儲存分層降本
- [Announcing AWS Fargate for Amazon ECS powered by AWS Graviton2 Processors](https://aws.amazon.com/about-aws/whats-new/2021/11/aws-fargate-amazon-ecs-aws-graviton2-processors) — Fargate ARM64／Graviton2 遷移，官方公告最高 40% 價格效能提升、20% 成本降低
- [Application Load Balancer 定價說明（LCU 與計費模型）](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) — ALB 架構與計費單位，供合併評估參考

### 定價頁（金額估算用；價格會變動，估算時以當下頁面為準）

- [AWS WAF 定價](https://aws.amazon.com/waf/pricing/) — Web ACL 固定月費
- [Elastic Load Balancing 定價](https://aws.amazon.com/elasticloadbalancing/pricing/) — ALB 小時費與 LCU
- [Amazon CloudFront 定價](https://aws.amazon.com/cloudfront/pricing/) — 流量與請求費用
- [Amazon RDS for PostgreSQL 定價](https://aws.amazon.com/rds/postgresql/pricing/) — On-Demand／Reserved Instance 入口（注意：逐時費率為動態載入，需搭配 Pricing Calculator 核實）
- [AWS Fargate 定價](https://aws.amazon.com/fargate/pricing/) — x86／ARM(Graviton) 每 vCPU-小時與每 GB-小時費率
- [Amazon VPC 定價](https://aws.amazon.com/vpc/pricing/) — Public IPv4 位址每小時費用（In-use／Idle 同價）
- [Amazon RDS Reserved Instances](https://aws.amazon.com/rds/reserved-instances/) — 各付款方式／期間的節省幅度

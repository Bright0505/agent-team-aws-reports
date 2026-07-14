# AWS 官方文件連結目錄 — 效能效率（PERF）

performance-reviewer 的引用來源（依支柱拆分，只讀這一份即可；使用規則與背景見 `references/aws-docs-common.md`）。最後驗證：2026-07-13。

- [Performance Efficiency Pillar 白皮書](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html) — 本支柱進入點

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

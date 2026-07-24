# AWS 官方文件連結目錄 — 可靠性（REL）

reliability-reviewer 的引用來源（依支柱拆分，只讀這一份即可；使用規則與背景見 `references/aws-docs-common.md`）。最後驗證：2026-07-24。

- [Reliability Pillar 白皮書](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) — 本支柱進入點

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
- [What is AWS Backup?](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html) — 集中備份治理進入點
- [Managing backups using backup plans](https://docs.aws.amazon.com/aws-backup/latest/devguide/about-backup-plans.html) — 備份計畫涵蓋範圍
- [Minimizing downtime with Multi-AZ (ElastiCache)](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/AutoFailover.html) — ElastiCache 自動故障切換
- [Amazon Redshift snapshots and backups](https://docs.aws.amazon.com/redshift/latest/mgmt/working-with-snapshots.html) — Redshift 快照保留
- [How Amazon EFS works](https://docs.aws.amazon.com/efs/latest/ug/how-it-works.html) — EFS Regional 跨 AZ 備援
- [Managed node groups (EKS)](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html) — EKS 節點群組跨 AZ 韌性

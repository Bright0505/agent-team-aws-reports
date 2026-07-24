# AWS 官方文件連結目錄 — 安全性（SEC）

security-auditor 的引用來源（依支柱拆分，只讀這一份即可；使用規則與背景見 `references/aws-docs-common.md`）。最後驗證：2026-07-24。

- [Security Pillar 白皮書](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) — 本支柱進入點

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

### IAM 細部授權（roles/groups/policies）

- [Apply least-privilege permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege) — 最小權限（過寬 `Action:*`/`Resource:*` 的依據）
- [Policies and permissions in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html) — 政策類型與評估
- [IAM roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) — Role 信任政策與跨帳號存取

### 應用整合與機密

- [Rotate AWS Secrets Manager secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html) — 密文自動輪替
- [What is a parameter?（含 SecureString 類型）](https://docs.aws.amazon.com/systems-manager/latest/userguide/what-is-a-parameter.html) — SSM 敏感參數用 SecureString 加密
- [Managed renewal for ACM certificates](https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html) — ACM 憑證自動續期與到期

### WAF 與合規

- [What is AWS WAF?](https://docs.aws.amazon.com/waf/latest/developerguide/what-is-aws-waf.html) — WAF 概念與適用場景
- [Associating or disassociating a web ACL with an AWS resource](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-associating-aws-resource.html) — Web ACL 掛在 ALB/API GW/CloudFront
- [Evaluating resources with AWS Config rules](https://docs.aws.amazon.com/config/latest/developerguide/evaluate-config.html) — Config 合規規則

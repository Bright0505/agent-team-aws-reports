#!/usr/bin/env bash
# AWS 唯讀掃描腳本
# 只使用 describe-* / list-* / get-* 唯讀 API，不對帳號做任何變更。
# 權限不足或服務未啟用時記錄到 data/scan-errors.log 並繼續執行。
#
# 用法：scripts/scan.sh [profile]
#   REGIONS="ap-east-2 us-east-1" scripts/scan.sh   # 指定區域（略過自動偵測）

set -u
PROFILE="${1:-default}"
export AWS_PROFILE="$PROFILE"
export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
ERRLOG="$DATA/scan-errors.log"
mkdir -p "$DATA"
: > "$ERRLOG"

# run <輸出檔名(不含.json)> <aws cli 參數...>
run() {
  local out="$1"; shift
  local dir; dir="$(dirname "$DATA/$out")"; mkdir -p "$dir"
  if aws "$@" --output json > "$DATA/$out.json" 2>>"$ERRLOG"; then
    echo "  ok   $out"
  else
    echo "  fail $out (見 scan-errors.log)"
    echo "FAILED: $out :: aws $*" >> "$ERRLOG"
    rm -f "$DATA/$out.json"
  fi
}

echo "=== 驗證身分 ==="
if ! aws sts get-caller-identity --output json > "$DATA/caller-identity.json" 2>>"$ERRLOG"; then
  echo "錯誤：AWS 憑證無效，請先執行 aws configure 或 aws sso login" >&2
  exit 1
fi
ACCOUNT_ID="$(jq -r .Account "$DATA/caller-identity.json")"
echo "帳號: $ACCOUNT_ID / 身分: $(jq -r .Arn "$DATA/caller-identity.json")"

DEFAULT_REGION="$(aws configure get region || echo ap-east-2)"

echo "=== 偵測使用中的區域 ==="
if [ -n "${REGIONS:-}" ]; then
  ACTIVE_REGIONS="$REGIONS"
  echo "使用指定區域: $ACTIVE_REGIONS"
else
  ACTIVE_REGIONS=""
  for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text 2>>"$ERRLOG"); do
    n="$(aws resourcegroupstaggingapi get-resources --region "$r" --resources-per-page 5 \
          --query 'length(ResourceTagMappingList)' --output text 2>>"$ERRLOG" || echo 0)"
    if [ "$n" != "0" ] && [ "$n" != "None" ]; then
      ACTIVE_REGIONS="$ACTIVE_REGIONS $r"
      echo "  有資源: $r"
    fi
  done
  # 偵測不到任何區域時退回預設區域
  [ -z "$ACTIVE_REGIONS" ] && ACTIVE_REGIONS="$DEFAULT_REGION"
fi
echo "$ACTIVE_REGIONS" | tr ' ' '\n' | sed '/^$/d' > "$DATA/active-regions.txt"

echo "=== 全域服務 ==="
run "global/iam-account-summary"    iam get-account-summary
run "global/iam-password-policy"    iam get-account-password-policy
run "global/iam-users"              iam list-users
run "global/iam-account-aliases"    iam list-account-aliases
# 逐一使用者：access key 與 MFA
mkdir -p "$DATA/global/iam-users-detail"
for u in $(jq -r '.Users[].UserName' "$DATA/global/iam-users.json" 2>/dev/null); do
  run "global/iam-users-detail/$u-access-keys" iam list-access-keys --user-name "$u"
  run "global/iam-users-detail/$u-mfa"         iam list-mfa-devices --user-name "$u"
done

run "global/s3-buckets" s3api list-buckets
mkdir -p "$DATA/global/s3-buckets-detail"
for b in $(jq -r '.Buckets[].Name' "$DATA/global/s3-buckets.json" 2>/dev/null); do
  run "global/s3-buckets-detail/$b-public-access-block" s3api get-public-access-block --bucket "$b"
  run "global/s3-buckets-detail/$b-encryption"          s3api get-bucket-encryption --bucket "$b"
  run "global/s3-buckets-detail/$b-versioning"          s3api get-bucket-versioning --bucket "$b"
  run "global/s3-buckets-detail/$b-lifecycle"           s3api get-bucket-lifecycle-configuration --bucket "$b"
  run "global/s3-buckets-detail/$b-policy-status"       s3api get-bucket-policy-status --bucket "$b"
done

run "global/cloudfront-distributions" cloudfront list-distributions
run "global/route53-hosted-zones"     route53 list-hosted-zones

echo "=== 成本（Cost Explorer / Budgets）==="
FIRST_OF_MONTH="$(date +%Y-%m-01)"
THREE_MONTHS_AGO="$(date -v-3m +%Y-%m-01 2>/dev/null || date -d '3 months ago' +%Y-%m-01)"
run "global/cost-by-service" ce get-cost-and-usage \
  --time-period "Start=$THREE_MONTHS_AGO,End=$FIRST_OF_MONTH" \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
run "global/budgets" budgets describe-budgets --account-id "$ACCOUNT_ID"

scan_region() {
  local R="$1"
  local P="regions/$R"
  echo "=== 區域掃描: $R ==="
  local A=(--region "$R")

  # 網路
  run "$P/vpcs"              ec2 describe-vpcs "${A[@]}"
  run "$P/subnets"           ec2 describe-subnets "${A[@]}"
  run "$P/route-tables"      ec2 describe-route-tables "${A[@]}"
  run "$P/internet-gateways" ec2 describe-internet-gateways "${A[@]}"
  run "$P/nat-gateways"      ec2 describe-nat-gateways "${A[@]}"
  run "$P/security-groups"   ec2 describe-security-groups "${A[@]}"
  run "$P/network-acls"      ec2 describe-network-acls "${A[@]}"
  run "$P/vpc-endpoints"     ec2 describe-vpc-endpoints "${A[@]}"
  run "$P/vpn-connections"   ec2 describe-vpn-connections "${A[@]}"
  run "$P/dx-connections"    directconnect describe-connections "${A[@]}"
  run "$P/eips"              ec2 describe-addresses "${A[@]}"

  # 運算
  run "$P/ec2-instances"     ec2 describe-instances "${A[@]}"
  run "$P/asg"               autoscaling describe-auto-scaling-groups "${A[@]}"
  run "$P/lambda-functions"  lambda list-functions "${A[@]}"
  run "$P/ecs-clusters"      ecs list-clusters "${A[@]}"
  run "$P/eks-clusters"      eks list-clusters "${A[@]}"

  # 儲存
  run "$P/ebs-volumes"       ec2 describe-volumes "${A[@]}"
  run "$P/ebs-snapshots"     ec2 describe-snapshots --owner-ids self "${A[@]}"

  # 資料庫
  run "$P/rds-instances"     rds describe-db-instances "${A[@]}"
  run "$P/rds-clusters"      rds describe-db-clusters "${A[@]}"
  run "$P/dynamodb-tables"   dynamodb list-tables "${A[@]}"
  mkdir -p "$DATA/$P/dynamodb-detail"
  for t in $(jq -r '.TableNames[]?' "$DATA/$P/dynamodb-tables.json" 2>/dev/null); do
    run "$P/dynamodb-detail/$t-describe" dynamodb describe-table --table-name "$t" "${A[@]}"
    run "$P/dynamodb-detail/$t-pitr"     dynamodb describe-continuous-backups --table-name "$t" "${A[@]}"
  done

  # 負載平衡
  run "$P/load-balancers"    elbv2 describe-load-balancers "${A[@]}"
  run "$P/target-groups"     elbv2 describe-target-groups "${A[@]}"
  mkdir -p "$DATA/$P/lb-listeners"
  for arn in $(jq -r '.LoadBalancers[]?.LoadBalancerArn' "$DATA/$P/load-balancers.json" 2>/dev/null); do
    name="$(basename "$arn")"
    run "$P/lb-listeners/$name" elbv2 describe-listeners --load-balancer-arn "$arn" "${A[@]}"
  done

  # 安全服務
  run "$P/cloudtrail-trails" cloudtrail describe-trails "${A[@]}"
  run "$P/config-recorders"  configservice describe-configuration-recorder-status "${A[@]}"
  run "$P/guardduty-detectors" guardduty list-detectors "${A[@]}"
  run "$P/securityhub"       securityhub describe-hub "${A[@]}"
  run "$P/kms-keys"          kms list-keys "${A[@]}"
  mkdir -p "$DATA/$P/kms-detail"
  for k in $(jq -r '.Keys[]?.KeyId' "$DATA/$P/kms-keys.json" 2>/dev/null); do
    run "$P/kms-detail/$k-describe" kms describe-key --key-id "$k" "${A[@]}"
    # 只有客戶自管金鑰能查輪替狀態，AWS 管理金鑰查詢會失敗，屬預期
    run "$P/kms-detail/$k-rotation" kms get-key-rotation-status --key-id "$k" "${A[@]}"
  done

  # 監控
  run "$P/cloudwatch-alarms" cloudwatch describe-alarms "${A[@]}"
  run "$P/log-groups"        logs describe-log-groups "${A[@]}"
}

for R in $(cat "$DATA/active-regions.txt"); do
  scan_region "$R"
done

# 掃描中繼資料
jq -n --arg account "$ACCOUNT_ID" \
      --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg regions "$(tr '\n' ' ' < "$DATA/active-regions.txt")" \
      '{account: $account, scanned_at: $time, regions: $regions}' > "$DATA/scan-meta.json"

echo ""
echo "=== 掃描完成 ==="
echo "資料位置: $DATA"
FAILS="$(grep -c '^FAILED' "$ERRLOG" 2>/dev/null || true)"
echo "失敗項目: $FAILS（詳見 data/scan-errors.log，多為服務未啟用或權限不足，屬預期）"

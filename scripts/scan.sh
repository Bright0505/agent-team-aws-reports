#!/usr/bin/env bash
# AWS 唯讀掃描腳本
# 只使用 describe-* / list-* / get-* 唯讀 API，不對帳號做任何變更。
# 權限不足或服務未啟用時記錄到 data/scan-errors.log 並繼續執行。
#
# 用法：scripts/scan.sh [profile] [period]
#   REGIONS="ap-east-2 us-east-1" scripts/scan.sh   # 指定區域（略過自動偵測）
#   scripts/scan.sh default 2026-06                  # 月報：2026 年 6 月（完整月）；2026-Q2 季報；2025 年報；留空=上個月
#   期別＝一個「已結束的完整週期」（報告主體）；成本另含前 N 期作趨勢比對。
#   資源盤點與效能指標一律為當下快照，不受期別影響。
#   期別來源優先序：PERIOD 環境變數 > 第二個位置參數 > 留空（上一個完整月）。

set -u
PROFILE="${1:-default}"
export AWS_PROFILE="$PROFILE"
export AWS_PAGER=""

# ── 報告期別與時間粒度（嚴格週期；預設「上一個完整月」）──────────────────
# 期別指向一個「已結束的完整週期」，報告主體＝該週期；成本另含前 N 期作趨勢比對。
#   月報 YYYY-MM（留空＝上個月）、季報 YYYY-QN、年報 YYYY。
# 觸發慣例：週期結束後才跑（例：7 月初跑 6 月、隔年初跑去年整年）。
shift_month() {  # $1=YYYY-MM-01 錨點  $2=帶號月位移(如 +1 -2)  → YYYY-MM-01
  date -j -v"${2}"m -f "%Y-%m-%d" "$1" +%Y-%m-01 2>/dev/null \
    || date -d "$1 ${2} month" +%Y-%m-01
}

PERIOD="${PERIOD:-${2:-}}"
if [ -z "$PERIOD" ]; then
  REPORT_TYPE="month"; TARGET_START="$(shift_month "$(date +%Y-%m-01)" -1)"; PERIOD="${TARGET_START%-01}"
elif [[ "$PERIOD" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  REPORT_TYPE="month"; TARGET_START="${PERIOD}-01"
elif [[ "$PERIOD" =~ ^([0-9]{4})-[Qq]([1-4])$ ]]; then
  REPORT_TYPE="quarter"
  TARGET_START="$(printf '%s-%02d-01' "${BASH_REMATCH[1]}" $(( (BASH_REMATCH[2]-1)*3 + 1 )))"
elif [[ "$PERIOD" =~ ^[0-9]{4}$ ]]; then
  REPORT_TYPE="year"; TARGET_START="${PERIOD}-01-01"
else
  echo "警告：無法解析期別 '$PERIOD'，退回上個月月報" >&2
  REPORT_TYPE="month"; TARGET_START="$(shift_month "$(date +%Y-%m-01)" -1)"; PERIOD="${TARGET_START%-01}"
fi

# 週期長度（月）與趨勢要含的前 N 期。月報＝主體 1 月＋前 2 月（＝近 3 月，與原行為一致）；
# 季報／年報的前 N 期為暫定值，待另議調整此處。
case "$REPORT_TYPE" in
  month)   SPAN=1;  TREND_PRIOR=2 ;;
  quarter) SPAN=3;  TREND_PRIOR=1 ;;   # 暫定：主體 1 季 + 前 1 季
  year)    SPAN=12; TREND_PRIOR=1 ;;   # 暫定：主體 1 年 + 前 1 年
esac
TARGET_END="$(shift_month "$TARGET_START" "+${SPAN}")"
COST_START="$(shift_month "$TARGET_START" "-$(( SPAN * TREND_PRIOR ))")"
COST_END="$TARGET_END"
COST_GRANULARITY="MONTHLY"

# 防呆：期別尚未結束（End 落在未來）時，成本截到本月 1 號並警告
THIS_MONTH="$(date +%Y-%m-01)"
if [[ "$COST_END" > "$THIS_MONTH" ]]; then
  echo "警告：期別 ${PERIOD} 尚未結束，成本截至 ${THIS_MONTH}（不含未完成月份）" >&2
  COST_END="$THIS_MONTH"
fi
echo "報告期別: ${PERIOD}（型別 ${REPORT_TYPE}，主體 [${TARGET_START}→${TARGET_END})，成本窗 [${COST_START}→${COST_END}) ${COST_GRANULARITY}）"

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
# 成本窗（COST_START/COST_END/COST_GRANULARITY）已於期別解析區塊依報告型別算好
run "global/cost-by-service" ce get-cost-and-usage \
  --time-period "Start=$COST_START,End=$COST_END" \
  --granularity "$COST_GRANULARITY" --metrics UnblendedCost \
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
      --arg period "$PERIOD" \
      --arg report_type "$REPORT_TYPE" \
      --arg target_start "$TARGET_START" \
      --arg target_end "$TARGET_END" \
      --arg cost_start "$COST_START" \
      --arg cost_end "$COST_END" \
      --arg cost_granularity "$COST_GRANULARITY" \
      '{account: $account, scanned_at: $time, regions: $regions,
        period: $period, report_type: $report_type,
        report_period: {start: $target_start, end: $target_end},
        cost_window: {start: $cost_start, end: $cost_end, granularity: $cost_granularity}}' > "$DATA/scan-meta.json"

# ── 確定性產生 data/inventory.md ─────────────────────────────────────────
# 數量、安全服務啟用狀態、關鍵安全旗標一律由 jq 從原始 JSON 算出、直接寫檔，
# 不經 LLM 手抄，確保 inventory 與 data/ 完全一致（消除摘要與原始檔矛盾）。
jqlen() {  # $1=檔案  $2=jq 陣列運算式  → 長度（檔不存在/錯誤時 0）
  [ -f "$1" ] && jq -r "try ((${2}) | length) catch 0" "$1" 2>/dev/null || echo 0
}
sum_region_len() {  # $1=區域內檔名  $2=jq 陣列運算式  → 跨區加總
  local total=0 r n
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    n="$(jqlen "$DATA/regions/$r/$1" "$2")"
    total=$(( total + ${n:-0} ))
  done < "$DATA/active-regions.txt"
  echo "$total"
}

write_inventory() {
  local INV="$DATA/inventory.md" G="$DATA/global"
  local n_s3 n_cf n_iam n_vpc n_subnet n_sg n_alb n_rds n_ddb n_ec2 n_lambda n_ecs n_nat n_ebs n_cwalarm
  n_s3="$(jqlen "$G/s3-buckets.json" '.Buckets')"
  n_cf="$(jqlen "$G/cloudfront-distributions.json" '.DistributionList.Items')"
  n_iam="$(jqlen "$G/iam-users.json" '.Users')"
  n_vpc="$(sum_region_len vpcs.json '.Vpcs')"
  n_subnet="$(sum_region_len subnets.json '.Subnets')"
  n_sg="$(sum_region_len security-groups.json '.SecurityGroups')"
  n_alb="$(sum_region_len load-balancers.json '.LoadBalancers')"
  n_rds="$(sum_region_len rds-instances.json '.DBInstances')"
  n_ddb="$(sum_region_len dynamodb-tables.json '.TableNames')"
  n_ec2="$(sum_region_len ec2-instances.json '[.Reservations[].Instances[]]')"
  n_lambda="$(sum_region_len lambda-functions.json '.Functions')"
  n_ecs="$(sum_region_len ecs-clusters.json '.clusterArns')"
  n_nat="$(sum_region_len nat-gateways.json '.NatGateways')"
  n_ebs="$(sum_region_len ebs-volumes.json '.Volumes')"
  n_cwalarm="$(sum_region_len cloudwatch-alarms.json '.MetricAlarms')"

  # 安全服務啟用狀態（跨區）
  local ct gd cfg sh sh_status cfg_status
  ct="$(sum_region_len cloudtrail-trails.json '.trailList')"
  gd="$(sum_region_len guardduty-detectors.json '.DetectorIds')"
  cfg="$(sum_region_len config-recorders.json '[.ConfigurationRecordersStatus[]? | select(.recording==true)]')"
  sh=0
  while IFS= read -r r; do [ -z "$r" ] && continue; [ -f "$DATA/regions/$r/securityhub.json" ] && sh=$(( sh + 1 )); done < "$DATA/active-regions.txt"
  [ "${cfg:-0}" -gt 0 ] && cfg_status="啟用（${cfg} recorder recording）" || cfg_status="未啟用"
  [ "${sh:-0}"  -gt 0 ] && sh_status="啟用（${sh} 區）" || sh_status="未啟用（未訂閱）"

  {
    echo "# 資源盤點摘要"
    echo
    echo "> 本檔的數量與啟用狀態由 \`scripts/scan.sh\` 以 jq 從 \`data/\` 原始 JSON 確定性產生，"
    echo "> 保證與原始檔一致；分析 agent 若需明細請直接讀對應 JSON。"
    echo
    echo "- 帳號：$ACCOUNT_ID"
    echo "- 掃描時間：$(jq -r .scanned_at "$DATA/scan-meta.json")"
    echo "- 掃描區域：$(tr '\n' ' ' < "$DATA/active-regions.txt")"
    echo "- 報告期別：${PERIOD} / ${REPORT_TYPE}；成本窗 ${COST_START} ~ ${COST_END} / ${COST_GRANULARITY}"
    echo
    echo "## 資源數量"
    echo
    echo "| 資源 | 數量 |"
    echo "|---|---:|"
    echo "| VPC | $n_vpc |"
    echo "| Subnet | $n_subnet |"
    echo "| Security Group | $n_sg |"
    echo "| ALB | $n_alb |"
    echo "| RDS 實例 | $n_rds |"
    echo "| DynamoDB 表 | $n_ddb |"
    echo "| EC2 實例 | $n_ec2 |"
    echo "| Lambda | $n_lambda |"
    echo "| ECS 叢集 | $n_ecs |"
    echo "| NAT Gateway | $n_nat |"
    echo "| EBS Volume | $n_ebs |"
    echo "| S3 Bucket | $n_s3 |"
    echo "| CloudFront 發佈 | $n_cf |"
    echo "| IAM 使用者 | $n_iam |"
    echo "| CloudWatch 告警 | $n_cwalarm |"
    echo
    echo "## 安全服務啟用狀態"
    echo
    echo "| 服務 | 狀態 |"
    echo "|---|---|"
    echo "| CloudTrail | $( [ "${ct:-0}" -gt 0 ] && echo "啟用（${ct} trail）" || echo "未啟用" ) |"
    echo "| GuardDuty | $( [ "${gd:-0}" -gt 0 ] && echo "啟用（${gd} detector）" || echo "未啟用" ) |"
    echo "| AWS Config | $cfg_status |"
    echo "| Security Hub | $sh_status |"
    echo
    echo "## S3 Bucket 關鍵旗標"
    echo
    echo "| Bucket | 預設加密 | Public Access Block | 版本控制 | Policy 公開 |"
    echo "|---|---|---|---|---|"
    while IFS= read -r b; do
      [ -z "$b" ] && continue
      local d="$G/s3-buckets-detail" enc pab ver pub
      enc="$( [ -f "$d/$b-encryption.json" ] && jq -r 'try (.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm) catch "無"' "$d/$b-encryption.json" 2>/dev/null || echo "無" )"
      pab="$( [ -f "$d/$b-public-access-block.json" ] && echo "有" || echo "無" )"
      ver="$( [ -f "$d/$b-versioning.json" ] && jq -r 'try (.Status // "未啟用") catch "未啟用"' "$d/$b-versioning.json" 2>/dev/null || echo "未啟用" )"
      pub="$( [ -f "$d/$b-policy-status.json" ] && jq -r 'try (if .PolicyStatus.IsPublic then "是" else "否" end) catch "否"' "$d/$b-policy-status.json" 2>/dev/null || echo "否" )"
      echo "| $b | ${enc:-無} | $pab | ${ver:-未啟用} | ${pub:-否} |"
    done < <(jq -r 'try (.Buckets[].Name) catch empty' "$G/s3-buckets.json" 2>/dev/null)
    echo
    echo "## RDS 實例關鍵旗標"
    echo
    echo "| 實例 | 引擎 | Multi-AZ | 靜態加密 | 公開存取 | 備份保留(天) |"
    echo "|---|---|---|---|---|---:|"
    while IFS= read -r r; do
      [ -z "$r" ] && continue
      jq -r 'try (.DBInstances[] | "| \(.DBInstanceIdentifier) | \(.Engine) \(.EngineVersion) | \(.MultiAZ) | \(.StorageEncrypted) | \(.PubliclyAccessible) | \(.BackupRetentionPeriod) |") catch empty' "$DATA/regions/$r/rds-instances.json" 2>/dev/null
    done < "$DATA/active-regions.txt"
    echo
    echo "## 對外開放的 Security Group（含 0.0.0.0/0 inbound）"
    echo
    while IFS= read -r r; do
      [ -z "$r" ] && continue
      jq -r 'try (.SecurityGroups[] | select(any(.IpPermissions[]?.IpRanges[]?; .CidrIp=="0.0.0.0/0")) | "- \(.GroupId)（\(.GroupName)）ports: " + ([.IpPermissions[] | select(any(.IpRanges[]?; .CidrIp=="0.0.0.0/0")) | (.FromPort // "all")|tostring] | join(","))) catch empty' "$DATA/regions/$r/security-groups.json" 2>/dev/null
    done < "$DATA/active-regions.txt"
    echo
    echo "## 資料缺口（掃描失敗項目）"
    echo
    if [ -s "$ERRLOG" ] && grep -q '^FAILED' "$ERRLOG"; then
      grep '^FAILED' "$ERRLOG" | sed 's/^FAILED: /- /'
    else
      echo "- （無）"
    fi
  } > "$INV"
  echo "已產生 data/inventory.md（確定性）"
}
write_inventory

echo ""
echo "=== 掃描完成 ==="
echo "資料位置: $DATA"
FAILS="$(grep -c '^FAILED' "$ERRLOG" 2>/dev/null || true)"
echo "失敗項目: ${FAILS}（詳見 data/scan-errors.log，多為服務未啟用或權限不足，屬預期）"

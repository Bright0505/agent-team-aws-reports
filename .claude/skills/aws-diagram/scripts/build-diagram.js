#!/usr/bin/env node
/**
 * 確定性架構圖產生器：data/ 掃描產物 → report/aws-architecture.drawio
 * 不經過任何 LLM；同樣輸入必得同樣輸出。全程只讀本機檔案，不碰 AWS 帳號。
 *
 * 用法（從專案根目錄）：
 *   node .claude/skills/aws-diagram/scripts/build-diagram.js
 *   node .claude/skills/aws-diagram/scripts/build-diagram.js --out report/aws-architecture.drawio
 *
 * 頁面結構（資料驅動，不寫死環境名）：
 *   頁 1「匯總」：全帳號一張——雲外入口 ＋ 帳號層服務欄 ＋ Region 內各 VPC 的公私分層拓撲
 *   頁 2「總覽」：使用者 → CloudFront → 各 VPC 縮略框／S3
 *   頁 3..N：每個「有工作負載（ALB/ECS/RDS/EC2 任一）」的 VPC 一頁
 *
 * 邊一律只畫「可證明的 join」，證明不了就不畫、不猜：
 *   CloudFront→ALB/S3＝origin domain 精確比對；ALB→ECS＝TG ARN 雙向 join；
 *   ECS→RDS＝RDS 的 SG inbound 允許 DB port 來自 ECS 的 SG 或涵蓋其 VPC/子網 CIDR。
 *
 * 版面調整改 LAYOUT / STYLES 常數；不要在產出的 .drawio 上手改（重跑會覆蓋）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WORK_ROOT = process.cwd();
const DATA = (...p) => path.join(WORK_ROOT, 'data', ...p);

// ---------- 參數 ----------
function parseArgs(argv) {
  const opts = { out: 'report/aws-architecture.drawio' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.slice(2) in opts) {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 缺少值`);
      opts[a.slice(2)] = v;
    } else fail(`未知參數：${a}`);
  }
  opts.out = path.isAbsolute(opts.out) ? opts.out : path.join(WORK_ROOT, opts.out);
  return opts;
}

function fail(msg) {
  console.error(`build-diagram 錯誤：${msg}`);
  process.exit(1);
}

// ---------- 讀檔 ----------
// 0 位元組檔＝「空回應＝未設定」的有效證據（見 CLAUDE.md），回 null 由呼叫端給預設值
function readJsonMaybe(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${path.relative(WORK_ROOT, p)} 不是有效 JSON：${e.message}`);
  }
}

function readJsonRequired(p) {
  if (!fs.existsSync(p)) {
    fail(`缺少掃描產物 ${path.relative(WORK_ROOT, p)}——請先跑 /report-aws（或其階段①掃描）`);
  }
  return readJsonMaybe(p);
}

// ---------- CIDR ----------
function cidrToRange(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr || '');
  if (!m) return null;
  const ip = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  const bits = +m[5];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, mask, bits };
}

// outer 是否涵蓋 inner（皆為 IPv4 CIDR 字串）
function cidrContains(outer, inner) {
  const o = cidrToRange(outer);
  const i = cidrToRange(inner);
  if (!o || !i) return false;
  return o.bits <= i.bits && ((i.base & o.mask) >>> 0) === o.base;
}

// ---------- 共用小工具 ----------
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const nameTag = (tags) => ((tags || []).find((t) => t.Key === 'Name') || {}).Value || '';

// ---------- 載入資料模型 ----------
function loadModel() {
  const caller = readJsonRequired(DATA('caller-identity.json'));
  const accountId = (caller && caller.Account) || fail('caller-identity.json 缺 Account');

  const cfRaw =
    readJsonMaybe(DATA('digest', 'cloudfront-distributions.json')) ||
    readJsonRequired(DATA('global', 'cloudfront-distributions.json'));
  const cfItems = ((cfRaw || {}).DistributionList || {}).Items || [];

  const s3Raw = readJsonRequired(DATA('global', 's3-buckets.json'));
  const buckets = ((s3Raw || {}).Buckets || []).map((b) => b.Name).sort();

  const r53 = readJsonMaybe(DATA('global', 'route53-hosted-zones.json'));
  const zones = ((r53 || {}).HostedZones || []).map((z) => z.Name).sort();

  const iamUsers = ((readJsonMaybe(DATA('global', 'iam-users.json')) || {}).Users || []).length;

  const regionsDir = DATA('regions');
  if (!fs.existsSync(regionsDir)) fail('缺少 data/regions/——請先跑 /report-aws 掃描');
  const regionNames = fs.readdirSync(regionsDir).filter((d) => fs.statSync(path.join(regionsDir, d)).isDirectory()).sort();
  if (regionNames.length === 0) fail('data/regions/ 底下沒有任何區域資料');

  const regions = regionNames.map((region) => loadRegion(region));

  // CloudFront origin → ALB / S3 的精確比對（跨區域收集 ALB DNS）
  const albByDns = new Map();
  for (const r of regions) for (const alb of r.albs) albByDns.set(alb.dns, alb);
  const cfs = cfItems
    .map((d) => {
      const targets = [];
      for (const o of d.Origins || []) {
        const dom = typeof o === 'string' ? o : o.DomainName || '';
        if (albByDns.has(dom)) {
          targets.push({ kind: 'alb', alb: albByDns.get(dom) });
        } else {
          const m = /^(.+?)\.s3[.-]/.exec(dom);
          if (m && buckets.includes(m[1])) targets.push({ kind: 's3', bucket: m[1] });
          else targets.push({ kind: 'unknown', domain: dom });
        }
      }
      return {
        id: d.Id,
        name: (d.Aliases && d.Aliases[0]) || d.DomainName || d.Id,
        aliases: d.Aliases || [],
        comment: d.Comment || '',
        enabled: d.Enabled !== false,
        targets,
      };
    })
    .sort(byName);

  return { accountId, cfs, buckets, zones, iamUsers, regions };
}

function loadRegion(region) {
  const R = (...p) => DATA('regions', region, ...p);

  const vpcsRaw = ((readJsonRequired(R('vpcs.json')) || {}).Vpcs || []);
  const subnetsRaw = ((readJsonRequired(R('subnets.json')) || {}).Subnets || []);
  const rtbs = ((readJsonRequired(R('route-tables.json')) || {}).RouteTables || []);
  const igws = ((readJsonRequired(R('internet-gateways.json')) || {}).InternetGateways || []);
  const nats = ((readJsonMaybe(R('nat-gateways.json')) || {}).NatGateways || []);
  const lbs = ((readJsonRequired(R('load-balancers.json')) || {}).LoadBalancers || []);
  const tgs = ((readJsonRequired(R('target-groups.json')) || {}).TargetGroups || []);
  const rdsList = ((readJsonRequired(R('rds-instances.json')) || {}).DBInstances || []);
  const sgs = ((readJsonRequired(R('security-groups.json')) || {}).SecurityGroups || []);
  const vpces = ((readJsonMaybe(R('vpc-endpoints.json')) || {}).VpcEndpoints || []);
  const ec2Rsv = ((readJsonMaybe(R('ec2-instances.json')) || {}).Reservations || []);

  // 有效路由表（與 network-facts.py 同一段 join，在 JS 重做）：
  // 子網明確關聯者用該表，否則落到 VPC 的 main route table
  const mainRtbByVpc = new Map();
  const rtbBySubnet = new Map();
  for (const rt of rtbs) {
    for (const as of rt.Associations || []) {
      if (as.Main) mainRtbByVpc.set(rt.VpcId, rt);
      else if (as.SubnetId) rtbBySubnet.set(as.SubnetId, rt);
    }
  }
  const rtbToIgw = (rt) => {
    if (!rt) return null;
    for (const route of rt.Routes || []) {
      if (route.DestinationCidrBlock === '0.0.0.0/0' && /^igw-/.test(route.GatewayId || '')) {
        return route.GatewayId;
      }
    }
    return null;
  };

  const subnets = subnetsRaw
    .map((s) => {
      const rt = rtbBySubnet.get(s.SubnetId) || mainRtbByVpc.get(s.VpcId) || null;
      const igwId = rtbToIgw(rt);
      const name = nameTag(s.Tags);
      return {
        id: s.SubnetId,
        vpcId: s.VpcId,
        az: s.AvailabilityZone,
        cidr: s.CidrBlock,
        name,
        isPublic: !!igwId,
        // 命名與實際組態的落差：名稱含 private 卻有 0.0.0.0/0 → IGW
        warnNamedPrivate: /private/i.test(name) && !!igwId,
      };
    })
    .sort((a, b) => (a.az + a.id < b.az + b.id ? -1 : 1));
  const subnetById = new Map(subnets.map((s) => [s.id, s]));

  // lb-listeners/：以檔內 LoadBalancerArn join（檔名只是 ARN 尾段）
  const listenersByLbArn = new Map();
  const lbDir = R('lb-listeners');
  if (fs.existsSync(lbDir)) {
    for (const f of fs.readdirSync(lbDir).sort()) {
      const j = readJsonMaybe(path.join(lbDir, f));
      for (const l of (j || {}).Listeners || []) {
        const arr = listenersByLbArn.get(l.LoadBalancerArn) || [];
        arr.push(`${l.Protocol}:${l.Port}`);
        listenersByLbArn.set(l.LoadBalancerArn, arr);
      }
    }
  }

  const sgById = new Map(sgs.map((g) => [g.GroupId, g]));
  const sgName = (id) => (sgById.get(id) || {}).GroupName || id;

  // 一組 SG 對 0.0.0.0/0 開放的埠（確定性算出，供匯總頁的 IGW→ALB 邊標用）
  // 回傳如 ['80', '443'] 或 ['ALL']；只看 IpRanges 含 0.0.0.0/0 的規則，不含 SG 對 SG
  function openToWorldPorts(sgIds) {
    const ports = new Set();
    for (const id of sgIds) {
      for (const p of (sgById.get(id) || {}).IpPermissions || []) {
        if (!(p.IpRanges || []).some((r) => r.CidrIp === '0.0.0.0/0')) continue;
        if (p.IpProtocol === '-1') ports.add('ALL');
        else if (p.FromPort === p.ToPort) ports.add(String(p.FromPort));
        else ports.add(`${p.FromPort}-${p.ToPort}`);
      }
    }
    return [...ports].sort((a, b) => (parseInt(a, 10) || 1e9) - (parseInt(b, 10) || 1e9));
  }

  const albs = lbs
    .map((lb) => ({
      arn: lb.LoadBalancerArn,
      name: lb.LoadBalancerName,
      dns: lb.DNSName,
      scheme: lb.Scheme,
      type: lb.Type,
      vpcId: lb.VpcId,
      subnetIds: (lb.AvailabilityZones || []).map((z) => (typeof z === 'string' ? z : z.SubnetId)),
      listeners: [...new Set(listenersByLbArn.get(lb.LoadBalancerArn) || [])].sort(),
      sgIds: lb.SecurityGroups || [],
      openPorts: openToWorldPorts(lb.SecurityGroups || []),
    }))
    .sort(byName);
  const albByArn = new Map(albs.map((a) => [a.arn, a]));

  const tgByArn = new Map(
    tgs.map((t) => [
      t.TargetGroupArn,
      { name: t.TargetGroupName, protocol: t.Protocol, port: t.Port, lbArns: t.LoadBalancerArns || [] },
    ])
  );

  // ecs-detail/*-services-detail.json → ECS 服務（launchType 缺時看 capacityProviderStrategy）
  const services = [];
  const ecsDir = R('ecs-detail');
  if (fs.existsSync(ecsDir)) {
    for (const f of fs.readdirSync(ecsDir).sort()) {
      if (!f.endsWith('-services-detail.json')) continue;
      const j = readJsonMaybe(path.join(ecsDir, f));
      for (const s of (j || {}).services || []) {
        const cfg = ((s.networkConfiguration || {}).awsvpcConfiguration || {});
        const subnetIds = cfg.subnets || [];
        const vpcId = subnetIds.length ? (subnetById.get(subnetIds[0]) || {}).vpcId : null;
        const tgArn = ((s.loadBalancers || [])[0] || {}).targetGroupArn || null;
        const tg = tgArn ? tgByArn.get(tgArn) : null;
        services.push({
          name: s.serviceName,
          cluster: (s.clusterArn || '').split('/').pop() || '',
          launchType:
            s.launchType || (((s.capacityProviderStrategy || [])[0] || {}).capacityProvider || '') || '?',
          desired: s.desiredCount,
          running: s.runningCount,
          sgIds: cfg.securityGroups || [],
          assignPublicIp: cfg.assignPublicIp || null,
          subnetIds,
          vpcId,
          tg,
          albArn: tg && tg.lbArns.length ? tg.lbArns[0] : null,
        });
      }
    }
  }
  services.sort(byName);

  const rdsInstances = rdsList
    .map((db) => {
      const grp = db.DBSubnetGroup || {};
      const subnetIds = (grp.Subnets || []).map((s) => s.SubnetIdentifier);
      // DB subnet group 公私混雜＝群組同時含公有與私有子網（依實際路由判定，不看命名）
      const tiers = new Set(subnetIds.map((id) => (subnetById.get(id) || {}).isPublic).filter((x) => x !== undefined));
      const anyPublic = tiers.has(true);
      return {
        name: db.DBInstanceIdentifier,
        engine: `${db.Engine || ''} ${db.EngineVersion || ''}`.trim(),
        az: db.AvailabilityZone || null,
        secondaryAz: db.SecondaryAvailabilityZone || null,
        subnetGroupName: grp.DBSubnetGroupName || '',
        subnetGroupMixed: tiers.size > 1,
        subnetGroupAllPublic: anyPublic && tiers.size === 1,
        multiAZ: !!db.MultiAZ,
        publiclyAccessible: !!db.PubliclyAccessible,
        port: (db.Endpoint || {}).Port || { postgres: 5432, mysql: 3306, mariadb: 3306 }[db.Engine] || null,
        sgIds: (db.VpcSecurityGroups || []).map((g) => g.VpcSecurityGroupId),
        subnetIds,
        vpcId: grp.VpcId || (subnetIds.length ? (subnetById.get(subnetIds[0]) || {}).vpcId : null),
      };
    })
    .sort(byName);

  const igwByVpc = new Map();
  for (const g of igws) {
    for (const at of g.Attachments || []) igwByVpc.set(at.VpcId, g.InternetGatewayId);
  }

  const ec2 = [];
  for (const rsv of ec2Rsv) {
    for (const inst of rsv.Instances || []) {
      if ((inst.State || {}).Name === 'terminated') continue;
      ec2.push({
        name: nameTag(inst.Tags) || inst.InstanceId,
        id: inst.InstanceId,
        type: inst.InstanceType,
        subnetId: inst.SubnetId,
        vpcId: inst.VpcId,
      });
    }
  }
  ec2.sort(byName);

  const vpcs = vpcsRaw
    .map((v) => {
      const vs = { id: v.VpcId, cidr: v.CidrBlock, isDefault: !!v.IsDefault, name: nameTag(v.Tags) || v.VpcId };
      vs.subnets = subnets.filter((s) => s.vpcId === v.VpcId);
      vs.albs = albs.filter((a) => a.vpcId === v.VpcId);
      vs.services = services.filter((s) => s.vpcId === v.VpcId);
      vs.rds = rdsInstances.filter((d) => d.vpcId === v.VpcId);
      vs.ec2 = ec2.filter((i) => i.vpcId === v.VpcId);
      vs.igwId = igwByVpc.get(v.VpcId) || null;
      vs.nats = nats.filter((n) => n.VpcId === v.VpcId && n.State !== 'deleted');
      vs.endpoints = vpces
        .filter((e) => e.VpcId === v.VpcId && e.State === 'available')
        .map((e) => ({ id: e.VpcEndpointId, service: (e.ServiceName || '').split('.').pop(), type: e.VpcEndpointType }));
      vs.hasWorkload = vs.albs.length + vs.services.length + vs.rds.length + vs.ec2.length > 0;
      return vs;
    })
    .sort(byName);

  // ECS→RDS：RDS 的 SG inbound 允許 DB port 來自服務的 SG，或來自涵蓋服務 VPC/子網 CIDR 的網段
  const vpcCidrById = new Map(vpcsRaw.map((v) => [v.VpcId, v.CidrBlock]));
  const ecsToRds = [];
  for (const db of rdsInstances) {
    if (!db.port) continue;
    const perms = db.sgIds.flatMap((id) => ((sgById.get(id) || {}).IpPermissions || []));
    const portOpen = perms.filter(
      (p) =>
        p.IpProtocol === '-1' ||
        ((p.FromPort == null || p.FromPort <= db.port) && (p.ToPort == null || db.port <= p.ToPort))
    );
    for (const svc of services) {
      if (svc.vpcId !== db.vpcId) continue; // 邊只畫同 VPC（同一頁）；跨 VPC 存取不在圖面範圍
      const svcCidrs = [vpcCidrById.get(svc.vpcId), ...svc.subnetIds.map((id) => (subnetById.get(id) || {}).cidr)]
        .filter(Boolean);
      const ok = portOpen.some(
        (p) =>
          (p.UserIdGroupPairs || []).some((g) => svc.sgIds.includes(g.GroupId)) ||
          (p.IpRanges || []).some((r) => svcCidrs.some((c) => cidrContains(r.CidrIp, c)))
      );
      if (ok) ecsToRds.push({ svc, db });
    }
  }

  // 帳號層（區域範圍）治理服務：空回應＝未設定，是有效證據（見 CLAUDE.md），照實標「未啟用」
  const recorders = ((readJsonMaybe(R('config-recorders.json')) || {}).ConfigurationRecordersStatus || []);
  const governance = {
    cloudtrail: ((readJsonMaybe(R('cloudtrail-trails.json')) || {}).trailList || []).length,
    config: recorders.filter((r) => r.recording).length,
    guardduty: ((readJsonMaybe(R('guardduty-detectors.json')) || {}).DetectorIds || []).length,
  };

  return { region, vpcs, subnets, albs, services, rdsInstances, ecsToRds, albByArn, sgName, governance };
}

// ---------- draw.io XML ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 樣式表：群組框用 mxgraph.aws4.group＋grIcon，資源用 resourceIcon（aws4 官方圖示庫）
const GROUP_BASE =
  'points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];' +
  'outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;' +
  'collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;align=left;spacingLeft=30;fillColor=none;';
// 樣式對齊 draw.io 現行 AWS 圖庫（2022+ 官方改版：扁平分類色、無漸層）——
// 顏色與描邊取自 Sidebar-AWS4.js 各分類區段的現行定義，不要退回 2019 世代的漸層舊色
const RES_BASE =
  'sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;strokeColor=#ffffff;dashed=0;' +
  'verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=10;fontStyle=0;aspect=fixed;' +
  'shape=mxgraph.aws4.resourceIcon;';
const resIcon = (name, fill) => `${RES_BASE}resIcon=mxgraph.aws4.${name};fillColor=${fill};`;
// 產品圖示：ALB/IGW/NAT/Endpoints/Users 等在 aws4 是獨立 shape，圖形以 fillColor 上色
//（漏給 fillColor 會變白描邊＋白底＝整顆隱形；官方樣式 strokeColor=none）
const prodIcon = (name, fill) =>
  `sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=${fill};strokeColor=none;dashed=0;verticalLabelPosition=bottom;` +
  `verticalAlign=top;align=center;html=1;whiteSpace=wrap;fontSize=10;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.${name};`;

const STYLES = {
  awsCloud: `${GROUP_BASE}grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fontColor=#232F3E;dashed=0;`,
  region: `${GROUP_BASE}grIcon=mxgraph.aws4.group_region;strokeColor=#147EBA;fontColor=#147EBA;dashed=1;`,
  vpc: `${GROUP_BASE}grIcon=mxgraph.aws4.group_vpc2;strokeColor=#8C4FFF;fontColor=#8C4FFF;dashed=0;`,
  band: (color) =>
    `rounded=1;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;` +
    `fillColor=none;strokeColor=${color};dashed=1;dashPattern=4 3;fontColor=${color};container=0;`,
  azBox:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=top;align=center;fillColor=none;' +
    'strokeColor=#545B64;dashed=1;dashPattern=3 3;fontColor=#545B64;container=0;',
  subnetPublic:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=9;verticalAlign=top;align=left;spacing=4;' +
    'fillColor=#E9F3E0;strokeColor=#7AA116;fontColor=#232F3E;container=0;',
  subnetPrivate:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=9;verticalAlign=top;align=left;spacing=4;' +
    'fillColor=#E6F2F8;strokeColor=#147EBA;fontColor=#232F3E;container=0;',
  subnetWarn:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=9;verticalAlign=top;align=left;spacing=4;' +
    'fillColor=#E9F3E0;strokeColor=#D13212;strokeWidth=2;fontColor=#232F3E;container=0;',
  vpcMini:
    'rounded=1;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=middle;align=center;' +
    'fillColor=#F5F0FF;strokeColor=#8C4FFF;fontColor=#232F3E;container=0;',
  label:
    'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=#545B64;',
  users: prodIcon('users', '#1E262E'),
  // 2022+ 官方分類色：Networking 紫 / Compute·Containers 橘 / Database 洋紅 / Storage 綠
  cloudfront: resIcon('cloudfront', '#8C4FFF'),
  route53: resIcon('route_53', '#8C4FFF'),
  igw: prodIcon('internet_gateway', '#8C4FFF'),
  natgw: prodIcon('nat_gateway', '#8C4FFF'),
  alb: prodIcon('application_load_balancer', '#8C4FFF'),
  vpce: prodIcon('endpoints', '#8C4FFF'),
  ecsService: resIcon('fargate', '#ED7100'),
  ec2: resIcon('ec2', '#ED7100'),
  rds: resIcon('rds', '#C925D1'),
  s3: resIcon('s3', '#7AA116'),
  edge:
    'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;fontSize=10;' +
    'strokeColor=#545B64;fontColor=#232F3E;endArrow=block;endFill=1;',
  // --- 匯總頁專用 ---
  // 層別直欄是「背景通道」不是容器（container=0）：子網與資源都疊在它上面，靠先後順序分層
  tierPublic:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=12;fontStyle=1;verticalAlign=top;align=center;spacingTop=4;' +
    'fillColor=#E9F3E0;strokeColor=#7AA116;fontColor=#5E7F11;container=0;',
  tierPrivate:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=12;fontStyle=1;verticalAlign=top;align=center;spacingTop=4;' +
    'fillColor=#E6F2F8;strokeColor=#147EBA;fontColor=#0F5E8C;container=0;',
  subTile:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=9;verticalAlign=middle;align=center;' +
    'fillColor=#FFFFFF;strokeColor=#879196;fontColor=#232F3E;container=0;',
  subTileWarn:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=9;verticalAlign=middle;align=center;' +
    'fillColor=#FFFFFF;strokeColor=#D13212;strokeWidth=2;fontColor=#232F3E;container=0;',
  // 資源列外框：橘＝跨層（子網集合同時含公有與私有），其餘依資源分類色
  rowFrame: (color, fill) =>
    `rounded=0;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;` +
    `fillColor=${fill};strokeColor=${color};fontColor=${color};container=0;`,
  rowFrameSpan:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=11;fontStyle=1;verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;' +
    'fillColor=#FFF4EC;strokeColor=#ED7100;strokeWidth=2;fontColor=#B85A00;container=0;',
  sgFrame:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=10;verticalAlign=top;align=center;spacingTop=2;' +
    'fillColor=none;strokeColor=#D13212;dashed=0;fontColor=#D13212;container=0;',
  govOn:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=middle;align=left;spacingLeft=10;' +
    'fillColor=#FFFFFF;strokeColor=#545B64;fontColor=#232F3E;container=0;',
  govOff:
    'rounded=0;whiteSpace=wrap;html=1;fontSize=11;verticalAlign=middle;align=left;spacingLeft=10;' +
    'fillColor=#F2F3F3;strokeColor=#B4BABF;fontColor=#879196;dashed=1;container=0;',
  sideTitle:
    'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=12;fontStyle=1;fontColor=#232F3E;',
};
const DISABLED = 'opacity=30;';
// 邊的錨點：垂直流量鏈（IGW→ALB→ECS→RDS）底出頂入；總覽頁橫向（使用者→CF→VPC/S3）右出左入
const V_FLOW = 'exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;';
const H_FLOW = 'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;';

// 版面常數（間距/尺寸都改這裡）
const LAYOUT = {
  icon: 78, // aws4 resourceIcon 標準邊長
  iconSlotW: 190, // 帶內每個圖示的水平槽寬（含標籤留白）
  bandH: 155, // 資源帶高度
  bandGap: 62, // 帶與帶之間（要留邊標籤的空間）
  subW: 220, // 子網格
  subH: 78,
  subGap: 10,
  azPad: 12,
  azGap: 16,
  frameMargin: 30, // VPC 框內距
};

class Page {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.cells = [];
    this.width = 1200;
    this.height = 900;
  }
  vertex(id, parent, value, style, x, y, w, h) {
    this.cells.push(
      `        <mxCell id="${esc(id)}" value="${esc(value)}" style="${esc(style)}" vertex="1" parent="${esc(parent)}">\n` +
        `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />\n` +
        `        </mxCell>`
    );
    return id;
  }
  edge(id, source, target, value = '', styleExtra = '') {
    this.cells.push(
      `        <mxCell id="${esc(id)}" value="${esc(value)}" style="${esc(STYLES.edge + styleExtra)}" edge="1" parent="1" source="${esc(
        source
      )}" target="${esc(target)}">\n          <mxGeometry relative="1" as="geometry" />\n        </mxCell>`
    );
  }
  toXml() {
    return (
      `  <diagram id="${esc(this.id)}" name="${esc(this.name)}">\n` +
      `    <mxGraphModel dx="800" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.ceil(
        this.width
      )}" pageHeight="${Math.ceil(this.height)}" math="0" shadow="0">\n` +
      `      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n` +
      this.cells.join('\n') +
      `\n      </root>\n    </mxGraphModel>\n  </diagram>`
    );
  }
}

// 匯總頁版面常數（只影響匯總頁；改這裡不動其他分頁）
const SUM = {
  icon: 78,
  colW: 470, // 單一層別通道寬
  colGap: 26,
  vpcPadX: 26,
  bandTop: 120, // VPC 框內：通道起點（上方留給標題與 IGW／VPC Endpoint 列）
  tierTitleH: 46, // 通道標題佔用高度（可能兩行：含 ⚠ 說明），子網方塊由此往下堆
  subH: 50,
  subGap: 8,
  subPad: 10,
  rowH: 170, // 資源列（外框）高
  rowGap: 24,
  rowPadTop: 28, // 外框標題佔用高度
  sgPad: 10,
  sgTitleH: 24,
  vpcGap: 40,
  sidebarW: 250,
  extW: 200, // 雲外左欄
  cfSlotH: 130,
};

// ---------- 頁 1：匯總（全帳號一張） ----------
// 版型：雲外入口欄 →｜AWS Cloud｜帳號層服務欄 ＋ Region 框（內含各 VPC 的公私分層拓撲）｜
// 一切依 data/ 可證明的事實：層別依實際路由、邊只畫可證明的 join、未設定的服務照實灰化標「未啟用」
function buildSummary(model, sd) {
  const S = SUM;
  const pg = new Page('summary', '匯總');

  // ---- 雲外左欄：使用者 → Route 53 → CloudFront ----
  const extX = 40;
  let ey = 60;
  const usersId = pg.vertex('sum-users', '1', '使用者', STYLES.users, extX + (S.extW - S.icon) / 2, ey, S.icon, S.icon);
  ey += 150;
  let upstreamId = usersId;
  if (model.zones.length) {
    upstreamId = pg.vertex(
      'sum-r53',
      '1',
      `Route 53<br>${model.zones.join('<br>')}`,
      STYLES.route53,
      extX + (S.extW - S.icon) / 2,
      ey,
      S.icon,
      S.icon
    );
    pg.edge('e-sum-users-r53', usersId, upstreamId, '', V_FLOW);
    ey += 150;
  }
  const cfTop = ey;
  model.cfs.forEach((cf, i) => {
    const label =
      `${cf.name}` +
      (cf.comment ? `<br>${cf.comment}` : '') +
      (cf.enabled ? '' : '<br><font color="#879196">（已停用）</font>');
    pg.vertex(
      `sum-cf-${cf.id}`,
      '1',
      label,
      STYLES.cloudfront + (cf.enabled ? '' : DISABLED),
      extX + (S.extW - S.icon) / 2,
      cfTop + i * S.cfSlotH,
      S.icon,
      S.icon
    );
    if (cf.enabled) pg.edge(`e-sum-up-${cf.id}`, upstreamId, `sum-cf-${cf.id}`, '', V_FLOW);
    sd.cloudfront++;
  });
  const extBottom = cfTop + Math.max(model.cfs.length, 1) * S.cfSlotH;

  // ---- Region 框內容先算好尺寸，雲框才好包 ----
  const vpcW = 2 * S.colW + S.colGap + 2 * S.vpcPadX;
  const regionBlocks = model.regions.map((r) => {
    const vpcs = r.vpcs.map((v) => ({ v, plan: planVpc(r, v) }));
    const h = 50 + vpcs.reduce((n, x) => n + x.plan.frameH + S.vpcGap, 0) + 10;
    return { r, vpcs, h };
  });
  const regionsH = regionBlocks.reduce((n, b) => n + b.h + 24, 0);

  // ---- 帳號層服務欄尺寸 ----
  const govRows = [];
  for (const r of model.regions) {
    govRows.push(['AWS CloudTrail', r.governance.cloudtrail, `${r.region}`]);
    govRows.push(['AWS Config', r.governance.config, `${r.region}`]);
    govRows.push(['Amazon GuardDuty', r.governance.guardduty, `${r.region}`]);
  }
  const sideH = 40 + govRows.length * 46 + 40 + model.buckets.length * 118 + 70;

  const cloudX = extX + S.extW + 70;
  const cloudY = 40;
  const sideX = 30;
  const regionX = sideX + S.sidebarW + 40;
  const regionW = vpcW + 60;
  const cloudW = regionX + regionW + 30;
  const cloudH = Math.max(sideH, regionsH) + 80;
  const cloud = pg.vertex(
    'sum-cloud',
    '1',
    `AWS Cloud（帳號 ${model.accountId}）`,
    STYLES.awsCloud,
    cloudX,
    cloudY,
    cloudW,
    cloudH
  );

  // ---- 帳號層服務欄 ----
  let sy = 50;
  pg.vertex('sum-side-title', cloud, '帳號層服務', STYLES.sideTitle, sideX, sy, S.sidebarW, 20);
  sy += 26;
  govRows.forEach(([name, count, scope], i) => {
    const on = count > 0;
    pg.vertex(
      `sum-gov-${i}`,
      cloud,
      `${name}<br>${scope}：${on ? `已啟用 × ${count}` : '未啟用'}`,
      on ? STYLES.govOn : STYLES.govOff,
      sideX,
      sy,
      S.sidebarW,
      40
    );
    sy += 46;
  });
  sy += 14;
  pg.vertex('sum-side-s3', cloud, `Amazon S3（${model.buckets.length}）`, STYLES.sideTitle, sideX, sy, S.sidebarW, 20);
  sy += 26;
  model.buckets.forEach((b, i) => {
    pg.vertex(`sum-s3-${b}`, cloud, b, STYLES.s3, sideX + 10, sy + i * 118, S.icon, S.icon);
    sd.s3++;
  });
  sy += model.buckets.length * 118 + 10;
  pg.vertex('sum-side-iam', cloud, `AWS IAM：使用者 × ${model.iamUsers}`, STYLES.sideTitle, sideX, sy, S.sidebarW, 20);

  // ---- Region 框與各 VPC ----
  let ry = 50;
  for (const blk of regionBlocks) {
    const regionCell = pg.vertex(`sum-region-${blk.r.region}`, cloud, blk.r.region, STYLES.region, regionX, ry, regionW, blk.h);
    let vy = 40;
    for (const { v, plan } of blk.vpcs) {
      drawVpcBlock(pg, regionCell, blk.r, v, plan, 30, vy, vpcW, sd);
      vy += plan.frameH + S.vpcGap;
    }
    ry += blk.h + 24;
  }

  // ---- CloudFront → ALB（origin domain 精確比對；證明不了的 origin 不畫）----
  for (const cf of model.cfs) {
    for (const t of cf.targets) {
      if (t.kind === 'alb') {
        pg.edge(`e-sum-${cf.id}-${t.alb.name}`, `sum-cf-${cf.id}`, `sum-alb-${t.alb.name}`, '', H_FLOW + (cf.enabled ? '' : DISABLED));
      } else if (t.kind === 's3') {
        pg.edge(`e-sum-${cf.id}-s3-${t.bucket}`, `sum-cf-${cf.id}`, `sum-s3-${t.bucket}`, '', H_FLOW + (cf.enabled ? '' : DISABLED));
      }
    }
  }

  pg.width = cloudX + cloudW + 60;
  pg.height = Math.max(cloudY + cloudH, extBottom) + 60;
  return pg;
}

// 依資源的子網集合判定層別：全公有→public、全私有→private、兩者皆有→span（跨層）
function tierOfSubnets(regionModel, subnetIds) {
  const tiers = new Set();
  for (const id of subnetIds) {
    const s = regionModel.subnets.find((x) => x.id === id);
    if (s) tiers.add(s.isPublic ? 'public' : 'private');
  }
  if (tiers.size === 0) return 'private';
  if (tiers.size > 1) return 'span';
  return [...tiers][0];
}

// 先算好一個 VPC 區塊要多高、有哪些資源列——畫之前要先知道尺寸，Region 框才包得住
function planVpc(regionModel, v) {
  const S = SUM;
  const azs = [...new Set(v.subnets.map((s) => s.az))].sort();
  const pubRows = Math.max(0, ...azs.map((az) => v.subnets.filter((s) => s.az === az && s.isPublic).length));
  const privRows = Math.max(0, ...azs.map((az) => v.subnets.filter((s) => s.az === az && !s.isPublic).length));
  const subBlockH = S.tierTitleH + Math.max(pubRows, privRows) * (S.subH + S.subGap);

  const rows = [];
  if (v.albs.length) {
    const sgIds = [...new Set(v.albs.flatMap((a) => a.sgIds))];
    const schemes = [...new Set(v.albs.map((a) => a.scheme))].join('/');
    rows.push({
      kind: 'alb',
      key: 'alb',
      title: `Application Load Balancer（${schemes}）`,
      tier: tierOfSubnets(regionModel, [...new Set(v.albs.flatMap((a) => a.subnetIds))]),
      sgIds,
      items: v.albs,
    });
  }
  for (const cluster of [...new Set(v.services.map((s) => s.cluster))].sort()) {
    const svcs = v.services.filter((s) => s.cluster === cluster).sort(byName);
    const lt = [...new Set(svcs.map((s) => s.launchType))].join('/');
    const pubIp = [...new Set(svcs.map((s) => s.assignPublicIp).filter(Boolean))].join('/');
    const tier = tierOfSubnets(regionModel, [...new Set(svcs.flatMap((s) => s.subnetIds))]);
    rows.push({
      kind: 'ecs',
      key: `ecs-${cluster}`,
      title:
        `ECS Cluster ${cluster}（${lt}）` +
        (tier === 'span' ? '　⚠ 工作負載子網同時含公有與私有' : '') +
        (pubIp ? `　assignPublicIp=${pubIp}` : ''),
      tier,
      sgIds: [...new Set(svcs.flatMap((s) => s.sgIds))],
      items: svcs,
    });
  }
  if (v.ec2.length) {
    rows.push({
      kind: 'ec2',
      key: 'ec2',
      title: 'Amazon EC2',
      tier: tierOfSubnets(regionModel, v.ec2.map((i) => i.subnetId)),
      sgIds: [],
      items: v.ec2,
    });
  }
  if (v.rds.length) {
    // 通道位置一律由 DB subnet group 的實際路由決定，不因「DB 理應在私有層」而美化——
    // 子網群組全部通 IGW 時就該畫在公有通道上，那正是要一眼看見的風險
    const tier = tierOfSubnets(regionModel, [...new Set(v.rds.flatMap((d) => d.subnetIds))]);
    const warn =
      tier === 'span' ? '　⚠ DB subnet group 公私混雜' : tier === 'public' ? '　⚠ DB subnet group 子網全部通 IGW' : '';
    rows.push({
      kind: 'rds',
      key: 'rds',
      title: `Amazon RDS${warn}`,
      tier,
      sgIds: [...new Set(v.rds.flatMap((d) => d.sgIds))],
      items: v.rds,
    });
  }

  const frameH = S.bandTop + subBlockH + rows.length * (S.rowH + S.rowGap) + 30;
  return { azs, pubRows, privRows, subBlockH, rows, frameH };
}

function drawVpcBlock(pg, parent, regionModel, v, plan, x, y, w, sd) {
  const S = SUM;
  const title = `${v.name}（${v.id}）${v.cidr}${v.isDefault ? '　default VPC' : ''}`;
  const frame = pg.vertex(`sum-vpc-${v.id}`, parent, title, STYLES.vpc, x, y, w, plan.frameH);

  const pubX = S.vpcPadX;
  const privX = S.vpcPadX + S.colW + S.colGap;
  const colX = { public: pubX, private: privX, span: pubX };
  const colW = { public: S.colW, private: S.colW, span: 2 * S.colW + S.colGap };

  // 頂列：IGW（左，貼公有通道）與 VPC Endpoint（右，貼私有通道）
  if (v.igwId) {
    pg.vertex(`sum-igw-${v.id}`, frame, `Internet Gateway<br>${v.igwId}`, STYLES.igw, pubX + 20, 30, S.icon, S.icon);
  }
  v.endpoints.forEach((e, i) => {
    pg.vertex(
      `sum-vpce-${e.id}`,
      frame,
      `VPC Endpoint（${e.type}）<br>${e.service}`,
      STYLES.vpce,
      privX + S.colW - 20 - (i + 1) * (S.icon + 40),
      30,
      S.icon,
      S.icon
    );
  });
  v.nats.forEach((n, i) => {
    pg.vertex(`sum-nat-${n.NatGatewayId}`, frame, `NAT Gateway<br>${n.NatGatewayId}`, STYLES.natgw, pubX + 140 + i * (S.icon + 40), 30, S.icon, S.icon);
  });

  // 兩條背景通道：全高，先畫（後畫的子網／資源會疊在上面）
  const bandH = plan.frameH - S.bandTop - 16;
  const misnamed = v.subnets.some((s) => s.warnNamedPrivate);
  pg.vertex(
    `sum-tier-pub-${v.id}`,
    frame,
    `公有子網通道（0.0.0.0/0 → IGW）` +
      (misnamed ? '<br><font color="#D13212">⚠＝命名 private，實際通 IGW</font>' : '') +
      (plan.pubRows === 0 ? '<br><font color="#879196">此 VPC 無公有子網</font>' : ''),
    STYLES.tierPublic,
    pubX,
    S.bandTop,
    S.colW,
    bandH
  );
  pg.vertex(
    `sum-tier-priv-${v.id}`,
    frame,
    `私有子網通道（無 0.0.0.0/0 → IGW）${plan.privRows === 0 ? '<br><font color="#879196">此 VPC 無私有子網</font>' : ''}`,
    STYLES.tierPrivate,
    privX,
    S.bandTop,
    S.colW,
    bandH
  );

  // 子網方塊：每 AZ 一欄堆在通道頂端；短名＝去掉 VPC 名前綴
  // （VPC 名可能帶 -vpc 後綴而子網名沒有，故兩種前綴都試）
  const prefixes = [`${v.name}-`, `${v.name.replace(/-vpc$/, '')}-`];
  const shortName = (s) => {
    const n = s.name || '（無 Name）';
    const p = prefixes.find((x) => n.startsWith(x) && n.length > x.length);
    return p ? n.slice(p.length) : n;
  };
  const n = Math.max(plan.azs.length, 1);
  const tileW = (S.colW - 2 * S.subPad - (n - 1) * S.subGap) / n;
  plan.azs.forEach((az, ai) => {
    for (const isPub of [true, false]) {
      const list = v.subnets.filter((s) => s.az === az && s.isPublic === isPub).sort(byName);
      const baseX = (isPub ? pubX : privX) + S.subPad + ai * (tileW + S.subGap);
      list.forEach((s, i) => {
        const label = `${s.warnNamedPrivate ? '⚠ ' : ''}${shortName(s)}<br>${s.cidr}<br>${s.az}`;
        pg.vertex(
          `sum-sub-${s.id}`,
          frame,
          label,
          s.warnNamedPrivate ? STYLES.subTileWarn : STYLES.subTile,
          baseX,
          S.bandTop + S.tierTitleH + i * (S.subH + S.subGap),
          tileW,
          S.subH
        );
        sd.subnet++;
      });
    }
  });

  // 資源列：由上而下＝流量鏈（ALB → ECS → EC2 → RDS）
  const rowColor = { alb: '#8C4FFF', ecs: '#ED7100', ec2: '#ED7100', rds: '#C925D1' };
  const rowFill = { alb: '#F7F2FF', ecs: '#FFF4EC', ec2: '#FFF4EC', rds: '#FDF0FE' };
  let ry = S.bandTop + plan.subBlockH + 10;
  const cellOf = new Map(); // key → 該列各資源的 cell id

  for (const row of plan.rows) {
    const rx = colX[row.tier];
    const rw = colW[row.tier];
    const frameStyle = row.tier === 'span' ? STYLES.rowFrameSpan : STYLES.rowFrame(rowColor[row.kind], rowFill[row.kind]);
    pg.vertex(`sum-row-${v.id}-${row.key}`, frame, row.title, frameStyle, rx, ry, rw, S.rowH);

    // SG 紅框：標題列放 SG 名稱（沒有 SG 資訊就不畫框，不編造）
    const sgX = rx + S.sgPad;
    const sgY = ry + S.rowPadTop;
    const sgW = rw - 2 * S.sgPad;
    const sgH = S.rowH - S.rowPadTop - 8;
    let sgId = null;
    if (row.sgIds.length) {
      const names = row.sgIds.map((id) => regionModel.sgName(id)).sort().join('、');
      sgId = pg.vertex(`sum-sg-${v.id}-${row.key}`, frame, `Security Group：${names}`, STYLES.sgFrame, sgX, sgY, sgW, sgH);
    }

    const items = row.items;
    const slot = sgW / items.length;
    const ids = [];
    items.forEach((item, i) => {
      const ix = sgX + i * slot + (slot - S.icon) / 2;
      const iy = sgY + S.sgTitleH + 4;
      let id;
      if (row.kind === 'alb') {
        id = pg.vertex(
          `sum-alb-${item.name}`,
          frame,
          `${item.name}<br>${item.listeners.join(' / ')}`,
          STYLES.alb,
          ix,
          iy,
          S.icon,
          S.icon
        );
        sd.alb++;
      } else if (row.kind === 'ecs') {
        id = pg.vertex(
          `sum-svc-${item.name}`,
          frame,
          `${item.name}<br>運行 ${item.running}/${item.desired}`,
          STYLES.ecsService,
          ix,
          iy,
          S.icon,
          S.icon
        );
        sd.ecsService++;
      } else if (row.kind === 'ec2') {
        id = pg.vertex(`sum-ec2-${item.id}`, frame, `${item.name}<br>${item.type}`, STYLES.ec2, ix, iy, S.icon, S.icon);
        sd.ec2++;
      } else {
        const warn =
          (item.publiclyAccessible ? '<br><font color="#D13212">⚠ 公開存取</font>' : '') +
          (item.subnetGroupMixed
            ? '<br><font color="#D13212">⚠ 子網群組公私混雜</font>'
            : item.subnetGroupAllPublic
              ? '<br><font color="#D13212">⚠ 子網群組全通 IGW</font>'
              : '');
        const azTxt = item.multiAZ && item.secondaryAz ? `${item.az} / ${item.secondaryAz}` : item.az || '';
        id = pg.vertex(
          `sum-rds-${item.name}`,
          frame,
          `${item.name}<br>${item.engine}${item.multiAZ ? '（Multi-AZ）' : ''}<br>${azTxt}${warn}`,
          STYLES.rds,
          ix,
          iy,
          S.icon,
          S.icon
        );
        sd.rds++;
      }
      ids.push({ item, id });
    });
    cellOf.set(row.key, { ids, sgId, row });
    ry += S.rowH + S.rowGap;
  }

  // ---- 邊：只畫可證明的 join ----
  const albRow = cellOf.get('alb');
  // IGW → ALB：邊標由 ALB 各 SG 中「IpRanges 含 0.0.0.0/0」的埠集合確定性算出
  if (v.igwId && albRow) {
    const ports = [...new Set(v.albs.flatMap((a) => a.openPorts))].sort(
      (a, b) => (parseInt(a, 10) || 1e9) - (parseInt(b, 10) || 1e9)
    );
    const label = ports.length ? `allow ${ports.join(',')} from 0.0.0.0/0` : '';
    const target = albRow.sgId || (albRow.ids[0] || {}).id;
    if (target) pg.edge(`e-sum-igw-${v.id}`, `sum-igw-${v.id}`, target, label, V_FLOW);
  }
  // ALB → ECS 服務：target group ARN 雙向 join
  for (const [key, grp] of cellOf) {
    if (!grp.row.kind.startsWith('ecs')) continue;
    for (const { item: svc, id } of grp.ids) {
      if (!svc.albArn || !albRow) continue;
      const hit = albRow.ids.find(({ item }) => item.arn === svc.albArn);
      if (hit) pg.edge(`e-sum-alb-${v.id}-${svc.name}`, hit.id, id, svc.tg ? `${svc.tg.protocol}:${svc.tg.port}` : '', V_FLOW);
    }
    void key;
  }
  // ECS → RDS：沿用 regionModel.ecsToRds（RDS 的 SG inbound 可證明放行 DB port）
  const rdsRow = cellOf.get('rds');
  if (rdsRow) {
    for (const { svc, db } of regionModel.ecsToRds) {
      const dbHit = rdsRow.ids.find(({ item }) => item === db);
      if (!dbHit) continue;
      for (const [, grp] of cellOf) {
        const svcHit = grp.row.kind === 'ecs' && grp.ids.find(({ item }) => item === svc);
        if (svcHit) pg.edge(`e-sum-${v.id}-${svc.name}-${db.name}`, svcHit.id, dbHit.id, `TCP:${db.port}`, V_FLOW);
      }
    }
  }
}

// ---------- 頁 2：總覽 ----------
function buildOverview(model, drawn) {
  const L = LAYOUT;
  const pg = new Page('overview', '總覽');

  const cfCount = model.cfs.length;
  const cfSlotH = 135;
  const cfColH = Math.max(cfCount * cfSlotH, 200);

  // Region 框（每區域一框，內含 VPC 縮略）
  const miniW = 300;
  const miniH = 96;
  const miniGap = 26;
  let regionBlocks = [];
  let regionsH = 0;
  for (const r of model.regions) {
    const h = 50 + r.vpcs.length * (miniH + miniGap) + 10;
    regionBlocks.push({ r, h });
    regionsH += h + 20;
  }

  const s3RowH = model.buckets.length ? 150 : 0;
  const zonesH = model.zones.length ? 130 : 0;

  const cloudX = 220;
  const cloudY = 40;
  const cfColX = 50; // 相對 cloud
  const regionX = 300;
  const regionW = miniW + 60;
  const innerH = Math.max(cfColH + zonesH, regionsH) + s3RowH + 60;
  const cloudW = regionX + regionW + 40;
  const cloudH = innerH + 60;

  const cloud = pg.vertex(
    'ov-cloud',
    '1',
    `AWS Cloud（帳號 ${model.accountId}）`,
    STYLES.awsCloud,
    cloudX,
    cloudY,
    cloudW,
    cloudH
  );

  // 使用者（雲外）
  pg.vertex('ov-users', '1', '使用者', STYLES.users, 60, cloudY + cfColH / 2, 78, 78);

  // Route 53（有 zone 才畫）
  let cfTop = 50;
  if (model.zones.length) {
    pg.vertex('ov-r53', cloud, `Route 53<br>${model.zones.join('<br>')}`, STYLES.route53, cfColX, cfTop, L.icon, L.icon);
    cfTop += zonesH;
  }

  // CloudFront 直欄
  model.cfs.forEach((cf, i) => {
    const label =
      `${cf.name}` +
      (cf.aliases.length > 1 ? `<br>${cf.aliases.slice(1).join('<br>')}` : '') +
      (cf.comment ? `<br>${cf.comment}` : '') +
      (cf.enabled ? '' : '<br>（已停用）');
    pg.vertex(
      `ov-cf-${cf.id}`,
      cloud,
      label,
      STYLES.cloudfront + (cf.enabled ? '' : DISABLED),
      cfColX,
      cfTop + i * cfSlotH,
      L.icon,
      L.icon
    );
    if (cf.enabled) pg.edge(`e-ov-users-${cf.id}`, 'ov-users', `ov-cf-${cf.id}`, '', H_FLOW);
    drawn.cloudfront++;
  });

  // Region 框與 VPC 縮略
  let ry = 50;
  for (const { r, h } of regionBlocks) {
    const regionCell = pg.vertex(`ov-region-${r.region}`, cloud, r.region, STYLES.region, regionX, ry, regionW, h);
    r.vpcs.forEach((v, i) => {
      const parts = [];
      if (v.subnets.length) parts.push(`子網×${v.subnets.length}`);
      if (v.albs.length) parts.push(`ALB×${v.albs.length}`);
      if (v.services.length) parts.push(`ECS服務×${v.services.length}`);
      if (v.rds.length) parts.push(`RDS×${v.rds.length}`);
      if (v.ec2.length) parts.push(`EC2×${v.ec2.length}`);
      const counts = v.hasWorkload ? parts.join('　') : `${parts.join('　')}（無工作負載）`;
      const title = v.isDefault ? `${v.name}（default）` : v.name;
      pg.vertex(
        `ov-vpc-${v.id}`,
        regionCell,
        `<b>${title}</b><br>${v.cidr}<br>${counts}${v.hasWorkload ? '<br>→ 詳見同名分頁' : ''}`,
        STYLES.vpcMini,
        30,
        40 + i * (miniH + miniGap),
        miniW,
        miniH
      );
      if (!v.hasWorkload) drawn.subnetAccounted += v.subnets.length;
    });
    ry += h + 20;
  }

  // S3 橫列
  if (model.buckets.length) {
    const s3Y = Math.max(cfTop + cfCount * cfSlotH, ry) + 20;
    pg.vertex('ov-s3-label', cloud, 'Amazon S3', STYLES.label, regionX, s3Y - 24, 200, 20);
    model.buckets.forEach((b, i) => {
      pg.vertex(`ov-s3-${b}`, cloud, b, STYLES.s3, regionX + i * 150, s3Y, L.icon, L.icon);
      drawn.s3++;
    });
  }

  // CloudFront → VPC 縮略／S3（同一 (cf, vpc) 去重）
  for (const cf of model.cfs) {
    const seenVpc = new Set();
    for (const t of cf.targets) {
      if (t.kind === 'alb' && !seenVpc.has(t.alb.vpcId)) {
        seenVpc.add(t.alb.vpcId);
        pg.edge(`e-ov-${cf.id}-${t.alb.vpcId}`, `ov-cf-${cf.id}`, `ov-vpc-${t.alb.vpcId}`, '', H_FLOW + (cf.enabled ? '' : DISABLED));
      } else if (t.kind === 's3') {
        pg.edge(`e-ov-${cf.id}-s3-${t.bucket}`, `ov-cf-${cf.id}`, `ov-s3-${t.bucket}`, '', H_FLOW + (cf.enabled ? '' : DISABLED));
      }
    }
  }

  pg.width = cloudX + cloudW + 60;
  pg.height = cloudY + cloudH + 60;
  return pg;
}

// ---------- 頁 2..N：每個有工作負載的 VPC ----------
function buildVpcPage(regionModel, v, drawn) {
  const L = LAYOUT;
  const pg = new Page(`vpc-${v.id}`, v.name);

  // 子網格尺寸（依實際路由分公私層；各 AZ 直欄、槽位跨欄對齊）
  const azNames = [...new Set(v.subnets.map((s) => s.az))].sort();
  const maxPub = Math.max(0, ...azNames.map((az) => v.subnets.filter((s) => s.az === az && s.isPublic).length));
  const maxPriv = Math.max(0, ...azNames.map((az) => v.subnets.filter((s) => s.az === az && !s.isPublic).length));
  const azW = L.subW + 2 * L.azPad;
  const gridW = azNames.length * azW + Math.max(0, azNames.length - 1) * L.azGap;
  const azH =
    30 + maxPub * (L.subH + L.subGap) + (maxPriv > 0 ? 14 + maxPriv * (L.subH + L.subGap) : 0) + 6;

  // 叢集分組（帶狀區塊由上而下：IGW → ALB → ECS(每叢集一帶) → EC2 → RDS → 子網格）
  const clusters = [...new Set(v.services.map((s) => s.cluster))].sort();
  const maxIcons = Math.max(v.albs.length, v.ec2.length, v.rds.length, ...clusters.map((c) => v.services.filter((s) => s.cluster === c).length), 1);
  const innerW = Math.max(gridW, maxIcons * L.iconSlotW + 40);
  const frameW = innerW + 2 * L.frameMargin;
  const M = L.frameMargin;

  // 框高先精算（與下方游標推進邏輯一致）：頂列 150 ＋ 各帶 ＋ 格標籤 30 ＋ 子網格 ＋ 下邊距
  let y = 60;
  const bandCount = (v.albs.length ? 1 : 0) + clusters.length + (v.ec2.length ? 1 : 0) + (v.rds.length ? 1 : 0);
  const frameH = 60 + 150 + bandCount * (L.bandH + L.bandGap) + 30 + azH + 30;
  const title = `${v.name}（${v.id}）${v.cidr} ｜ ${regionModel.region}`;
  const frame = pg.vertex(`f-${v.id}`, '1', title, STYLES.vpc, 40, 40, frameW, frameH);

  const cx = M + innerW / 2;

  // IGW 與 VPC Gateway Endpoint / NAT（頂列）
  let igwCell = null;
  if (v.igwId) {
    igwCell = pg.vertex(`${v.id}-igw`, frame, `Internet Gateway<br>${v.igwId}`, STYLES.igw, cx - L.icon / 2, y, L.icon, L.icon);
  }
  v.endpoints.forEach((e, i) => {
    pg.vertex(
      `${v.id}-vpce-${e.id}`,
      frame,
      `VPC Endpoint（${e.type}）<br>${e.service}`,
      STYLES.vpce,
      M + innerW - (i + 1) * (L.icon + 60),
      y,
      L.icon,
      L.icon
    );
  });
  v.nats.forEach((n, i) => {
    pg.vertex(`${v.id}-nat-${n.NatGatewayId}`, frame, `NAT Gateway<br>${n.NatGatewayId}`, STYLES.natgw, M + i * (L.icon + 60), y, L.icon, L.icon);
  });
  y += 150;

  // 帶內圖示排位工具（x 為帶內相對座標）
  const placeRow = (items, mk) => {
    const slot = Math.max(L.iconSlotW, (innerW - 20) / Math.max(items.length, 1));
    items.forEach((item, i) => {
      mk(item, 10 + i * slot + (slot - L.icon) / 2, i);
    });
  };

  // ALB 帶
  const albCellByArn = new Map();
  if (v.albs.length) {
    const pubAzCount = new Set(
      v.albs.flatMap((a) => a.subnetIds.map((id) => (regionModel.subnets.find((s) => s.id === id) || {}).az)).filter(Boolean)
    ).size;
    const band = pg.vertex(
      `${v.id}-band-alb`,
      frame,
      `Application Load Balancer（internet-facing，位於公有子網 × ${pubAzCount} AZ）`,
      STYLES.band('#8C4FFF'),
      M,
      y,
      innerW,
      L.bandH
    );
    placeRow(v.albs, (alb, x) => {
      const id = pg.vertex(`${v.id}-alb-${alb.name}`, band, alb.name, STYLES.alb, x, 34, L.icon, L.icon);
      albCellByArn.set(alb.arn, id);
      drawn.alb++;
      if (igwCell) pg.edge(`e-${v.id}-igw-${alb.name}`, igwCell, id, alb.listeners.join(' / '), V_FLOW);
    });
    y += L.bandH + L.bandGap;
  }

  // ECS 帶（每叢集一帶；服務排序跟隨其 ALB 的順序以減少交叉）
  const svcCellByName = new Map();
  for (const cluster of clusters) {
    const svcs = v.services
      .filter((s) => s.cluster === cluster)
      .sort((a, b) => {
        const ai = v.albs.findIndex((x) => x.arn === a.albArn);
        const bi = v.albs.findIndex((x) => x.arn === b.albArn);
        return ai - bi || byName(a, b);
      });
    const lt = [...new Set(svcs.map((s) => s.launchType))].join('/');
    const subnetCount = new Set(svcs.flatMap((s) => s.subnetIds)).size;
    const band = pg.vertex(
      `${v.id}-band-ecs-${cluster}`,
      frame,
      `ECS Cluster ${cluster}（${lt}，跨子網 × ${subnetCount}）`,
      STYLES.band('#ED7100'),
      M,
      y,
      innerW,
      L.bandH
    );
    placeRow(svcs, (svc, x) => {
      const id = pg.vertex(
        `${v.id}-svc-${svc.name}`,
        band,
        `${svc.name}<br>運行 ${svc.running}/${svc.desired}`,
        STYLES.ecsService,
        x,
        34,
        L.icon,
        L.icon
      );
      svcCellByName.set(svc.name, id);
      drawn.ecsService++;
      if (svc.albArn && albCellByArn.has(svc.albArn)) {
        pg.edge(`e-${v.id}-alb-${svc.name}`, albCellByArn.get(svc.albArn), id, svc.tg ? `${svc.tg.protocol}:${svc.tg.port}` : '', V_FLOW);
      }
    });
    y += L.bandH + L.bandGap;
  }

  // EC2 帶
  if (v.ec2.length) {
    const band = pg.vertex(`${v.id}-band-ec2`, frame, 'EC2', STYLES.band('#ED7100'), M, y, innerW, L.bandH);
    placeRow(v.ec2, (inst, x) => {
      pg.vertex(`${v.id}-ec2-${inst.id}`, band, `${inst.name}<br>${inst.type}<br>${inst.subnetId}`, STYLES.ec2, x, 34, L.icon, L.icon);
      drawn.ec2++;
    });
    y += L.bandH + L.bandGap;
  }

  // RDS 帶
  if (v.rds.length) {
    const band = pg.vertex(
      `${v.id}-band-rds`,
      frame,
      `RDS（DB subnet group 跨子網 × ${new Set(v.rds.flatMap((d) => d.subnetIds)).size}）`,
      STYLES.band('#3334B9'),
      M,
      y,
      innerW,
      L.bandH
    );
    placeRow(v.rds, (db, x) => {
      // 警示只上在標籤文字，不動 strokeColor——resourceIcon 的圖形本體是用 strokeColor 畫的，
      // 覆寫會把整個圖形塗成紅色（看起來像另一顆圖示）
      const warn = db.publiclyAccessible ? '<br><font color="#D13212">⚠ 公開存取</font>' : '';
      const id = pg.vertex(
        `${v.id}-rds-${db.name}`,
        band,
        `${db.name}<br>${db.engine}${db.multiAZ ? '（Multi-AZ）' : ''}${warn}`,
        STYLES.rds,
        x,
        34,
        L.icon,
        L.icon
      );
      drawn.rds++;
      for (const { svc, db: d2 } of regionModel.ecsToRds) {
        if (d2 === db && svcCellByName.has(svc.name)) {
          pg.edge(`e-${v.id}-${svc.name}-${db.name}`, svcCellByName.get(svc.name), id, `TCP:${db.port}`, V_FLOW);
        }
      }
    });
    y += L.bandH + L.bandGap;
  }

  // 子網格（依實際路由分層，不看命名）
  pg.vertex(`${v.id}-grid-label`, frame, '子網配置（依實際路由分層；⚠＝命名 private 但實際通 IGW）', STYLES.label, M, y, innerW, 20);
  y += 30;
  azNames.forEach((az, ai) => {
    const azX = M + ai * (azW + L.azGap);
    const azCell = pg.vertex(`${v.id}-az-${az}`, frame, az, STYLES.azBox, azX, y, azW, azH);
    const pub = v.subnets.filter((s) => s.az === az && s.isPublic).sort(byName);
    const priv = v.subnets.filter((s) => s.az === az && !s.isPublic).sort(byName);
    const put = (s, row, tierBase) => {
      const label =
        `${s.warnNamedPrivate ? '⚠ ' : ''}${s.name || '（無 Name）'}<br>${s.cidr}` +
        `${s.warnNamedPrivate ? '<br>命名 private，實際通 IGW' : ''}`;
      const style = s.warnNamedPrivate ? STYLES.subnetWarn : s.isPublic ? STYLES.subnetPublic : STYLES.subnetPrivate;
      pg.vertex(`${v.id}-sub-${s.id}`, azCell, label, style, L.azPad, tierBase + row * (L.subH + L.subGap), L.subW, L.subH);
      drawn.subnet++;
    };
    pub.forEach((s, i) => put(s, i, 30));
    priv.forEach((s, i) => put(s, i, 30 + maxPub * (L.subH + L.subGap) + 14));
  });

  pg.width = 40 + frameW + 60;
  pg.height = 40 + frameH + 60;
  return pg;
}

// ---------- 主流程 ----------
function main() {
  const opts = parseArgs(process.argv);
  const model = loadModel();

  const drawn = { cloudfront: 0, s3: 0, alb: 0, ecsService: 0, rds: 0, ec2: 0, subnet: 0, subnetAccounted: 0 };
  // 匯總頁自成一套計數器（它把每樣東西各畫一次），不與 drawn 混用以免重複計數
  const sd = { cloudfront: 0, s3: 0, alb: 0, ecsService: 0, rds: 0, ec2: 0, subnet: 0 };
  const pages = [buildSummary(model, sd), buildOverview(model, drawn)];
  for (const r of model.regions) {
    for (const v of r.vpcs) {
      if (v.hasWorkload) pages.push(buildVpcPage(r, v, drawn));
    }
  }

  // 自我檢查：畫出數量必須等於來源 JSON 數量（子網＝畫出＋總覽計數標籤兩者涵蓋）
  const src = {
    cloudfront: model.cfs.length,
    s3: model.buckets.length,
    alb: model.regions.reduce((n, r) => n + r.albs.length, 0),
    ecsService: model.regions.reduce((n, r) => n + r.services.length, 0),
    rds: model.regions.reduce((n, r) => n + r.rdsInstances.length, 0),
    subnet: model.regions.reduce((n, r) => n + r.subnets.length, 0),
    ec2: model.regions.reduce((n, r) => n + r.vpcs.reduce((m, v) => m + v.ec2.length, 0), 0),
  };
  const problems = [];
  // 匯總頁：每樣資源都應恰好畫出一次（含無工作負載的 VPC 的子網）
  for (const k of ['cloudfront', 's3', 'alb', 'ecsService', 'rds', 'ec2', 'subnet']) {
    if (sd[k] !== src[k]) problems.push(`匯總頁 ${k} 畫出 ${sd[k]} ≠ 來源 ${src[k]}`);
  }
  if (drawn.cloudfront !== src.cloudfront) problems.push(`CloudFront 畫出 ${drawn.cloudfront} ≠ 來源 ${src.cloudfront}`);
  if (drawn.s3 !== src.s3) problems.push(`S3 畫出 ${drawn.s3} ≠ 來源 ${src.s3}`);
  if (drawn.alb !== src.alb) problems.push(`ALB 畫出 ${drawn.alb} ≠ 來源 ${src.alb}`);
  if (drawn.ecsService !== src.ecsService) problems.push(`ECS 服務畫出 ${drawn.ecsService} ≠ 來源 ${src.ecsService}`);
  if (drawn.rds !== src.rds) problems.push(`RDS 畫出 ${drawn.rds} ≠ 來源 ${src.rds}`);
  if (drawn.subnet + drawn.subnetAccounted !== src.subnet) {
    problems.push(`子網涵蓋 ${drawn.subnet}＋總覽計數 ${drawn.subnetAccounted} ≠ 來源 ${src.subnet}`);
  }
  if (problems.length) fail(`計數斷言失敗：\n  - ${problems.join('\n  - ')}`);

  const xml =
    `<mxfile host="build-diagram.js" agent="build-diagram.js" version="1" type="device">\n` +
    pages.map((p) => p.toXml()).join('\n') +
    `\n</mxfile>\n`;

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, xml, 'utf8');

  const rel = path.relative(WORK_ROOT, opts.out);
  console.log(`已產生 ${rel}（${pages.length} 頁）`);
  console.log(`  分頁：${pages.map((p) => p.name).join('、')}`);
  console.log(
    `  計數（畫出/來源）：CloudFront ${drawn.cloudfront}/${src.cloudfront}、S3 ${drawn.s3}/${src.s3}、` +
      `ALB ${drawn.alb}/${src.alb}、ECS 服務 ${drawn.ecsService}/${src.ecsService}、RDS ${drawn.rds}/${src.rds}、` +
      `子網 ${drawn.subnet}＋總覽計數 ${drawn.subnetAccounted}/${src.subnet}`
  );
  console.log(
    `  匯總頁（畫出/來源）：CloudFront ${sd.cloudfront}/${src.cloudfront}、S3 ${sd.s3}/${src.s3}、ALB ${sd.alb}/${src.alb}、` +
      `ECS 服務 ${sd.ecsService}/${src.ecsService}、RDS ${sd.rds}/${src.rds}、EC2 ${sd.ec2}/${src.ec2}、子網 ${sd.subnet}/${src.subnet}`
  );
  console.log('  請用 app.diagrams.net 或 VS Code Draw.io 擴充開啟目視確認（可對照 data/inventory.md）');
}

main();

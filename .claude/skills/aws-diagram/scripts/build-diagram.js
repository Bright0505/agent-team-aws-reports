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
 *   頁 1「總覽」：使用者 → CloudFront → 各 VPC 縮略框／S3
 *   頁 2..N：每個「有工作負載（ALB/ECS/RDS/EC2 任一）」的 VPC 一頁
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

  return { accountId, cfs, buckets, zones, regions };
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
          subnetIds,
          vpcId,
          tg,
          albArn: tg && tg.lbArns.length ? tg.lbArns[0] : null,
        });
      }
    }
  }
  services.sort(byName);

  const sgById = new Map(sgs.map((g) => [g.GroupId, g]));

  const rdsInstances = rdsList
    .map((db) => {
      const grp = db.DBSubnetGroup || {};
      const subnetIds = (grp.Subnets || []).map((s) => s.SubnetIdentifier);
      return {
        name: db.DBInstanceIdentifier,
        engine: `${db.Engine || ''} ${db.EngineVersion || ''}`.trim(),
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

  return { region, vpcs, subnets, albs, services, rdsInstances, ecsToRds, albByArn };
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
const RES_BASE =
  'sketch=0;outlineConnect=0;fontColor=#232F3E;gradientDirection=north;strokeColor=#ffffff;dashed=0;' +
  'verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=10;fontStyle=0;aspect=fixed;' +
  'shape=mxgraph.aws4.resourceIcon;';
const resIcon = (name, fill, grad) => `${RES_BASE}resIcon=mxgraph.aws4.${name};fillColor=${fill};gradientColor=${grad};`;
// 產品圖示（stencil 自帶配色，不吃 fillColor）：ALB/IGW/NAT/Endpoints/Users 等在 aws4 是獨立 shape
const prodIcon = (name) =>
  'sketch=0;outlineConnect=0;fontColor=#232F3E;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;' +
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
  users: prodIcon('users'),
  // aws4 分類色：網路紫、運算橘、資料庫藍、儲存綠
  cloudfront: resIcon('cloudfront', '#5A30B5', '#945DF2'),
  route53: resIcon('route_53', '#5A30B5', '#945DF2'),
  igw: prodIcon('internet_gateway'),
  natgw: prodIcon('nat_gateway'),
  alb: prodIcon('application_load_balancer'),
  vpce: prodIcon('endpoints'),
  ecsService: resIcon('fargate', '#D05C17', '#F78E04'),
  ec2: resIcon('ec2', '#D05C17', '#F78E04'),
  rds: resIcon('rds', '#3334B9', '#4D72F3'),
  s3: resIcon('s3', '#277116', '#60A337'),
  edge:
    'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;fontSize=10;' +
    'strokeColor=#545B64;fontColor=#232F3E;endArrow=block;endFill=1;',
};
const DISABLED = 'opacity=30;';

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

// ---------- 頁 1：總覽 ----------
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
    if (cf.enabled) pg.edge(`e-ov-users-${cf.id}`, 'ov-users', `ov-cf-${cf.id}`);
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
        pg.edge(`e-ov-${cf.id}-${t.alb.vpcId}`, `ov-cf-${cf.id}`, `ov-vpc-${t.alb.vpcId}`, '', cf.enabled ? '' : DISABLED);
      } else if (t.kind === 's3') {
        pg.edge(`e-ov-${cf.id}-s3-${t.bucket}`, `ov-cf-${cf.id}`, `ov-s3-${t.bucket}`, '', cf.enabled ? '' : DISABLED);
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
      if (igwCell) pg.edge(`e-${v.id}-igw-${alb.name}`, igwCell, id, alb.listeners.join(' / '));
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
        pg.edge(`e-${v.id}-alb-${svc.name}`, albCellByArn.get(svc.albArn), id, svc.tg ? `${svc.tg.protocol}:${svc.tg.port}` : '');
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
      const warn = db.publiclyAccessible ? '<br>⚠ 公開存取' : '';
      const id = pg.vertex(
        `${v.id}-rds-${db.name}`,
        band,
        `${db.name}<br>${db.engine}${db.multiAZ ? '（Multi-AZ）' : ''}${warn}`,
        STYLES.rds + (db.publiclyAccessible ? 'strokeColor=#D13212;' : ''),
        x,
        34,
        L.icon,
        L.icon
      );
      drawn.rds++;
      for (const { svc, db: d2 } of regionModel.ecsToRds) {
        if (d2 === db && svcCellByName.has(svc.name)) {
          pg.edge(`e-${v.id}-${svc.name}-${db.name}`, svcCellByName.get(svc.name), id, `TCP:${db.port}`);
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
  const pages = [buildOverview(model, drawn)];
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
  };
  const problems = [];
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
  console.log('  請用 app.diagrams.net 或 VS Code Draw.io 擴充開啟目視確認（可對照 data/inventory.md）');
}

main();

/* 连排推算器/解析器冒烟测试（node 环境，esbuild 打包后运行） */
import { parseScheduleText } from '../src/utils/scheduleParser';
import { planRehearsal, buildBasisSignature, collectOccupied } from '../src/utils/rehearsalPlanner';
import { detectSessionConflicts } from '../src/utils/sessionConflicts';
import { toSessionRows } from '../src/utils/rehearsalPlanner';
import type { LocalBasis } from '../src/utils/rehearsalPlanner';
import type { AvailabilityPackage } from '../src/types/rehearsal';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function mkBasis(): LocalBasis {
  const stamp = new Date('2026-01-01T00:00:00Z').toISOString();
  const operators = [
    { id: 'o1', name: '霍连生', busySlots: [], assignedRoleIds: [], skillTags: [], rehearsalHours: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'o2', name: '苗凤仪', busySlots: [], assignedRoleIds: [], skillTags: [], rehearsalHours: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'o3', name: '裴三保', busySlots: [], assignedRoleIds: [], skillTags: [], rehearsalHours: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ];
  const plays = [
    { id: 'p1', title: '甲戏', genre: 'traditional', scriptText: '', totalScenes: 2, premiereVenue: '', status: 'rehearsing', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'p2', title: '乙戏', genre: 'traditional', scriptText: '', totalScenes: 1, premiereVenue: '', status: 'rehearsing', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ];
  const scenes = [
    { id: 's1', playId: 'p1', seq: 1, title: '甲一场', durationMin: 60, stageNote: '', needsShadowScreen: 'standard', progress: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 's2', playId: 'p1', seq: 2, title: '甲二场', durationMin: 60, stageNote: '', needsShadowScreen: 'standard', progress: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 's3', playId: 'p2', seq: 1, title: '乙一场', durationMin: 60, stageNote: '', needsShadowScreen: 'standard', progress: 0, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ];
  const roles = [
    { id: 'r1', sceneId: 's1', name: '角色A', roleType: 'sheng', propParts: [], entranceCue: '', lineNote: '', operatorId: 'o1', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'r2', sceneId: 's2', name: '角色B', roleType: 'dan', propParts: [], entranceCue: '', lineNote: '', operatorId: 'o2', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'r3', sceneId: 's3', name: '角色C', roleType: 'jing', propParts: [], entranceCue: '', lineNote: '', operatorId: 'o1', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ];
  const cues = [
    { id: 'c1', sceneId: 's2', beatName: 'jijifeng', instrument: 'bangu', atSecond: 10, leadOperator: 'o3', note: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ];
  return { plays, scenes, roles, cues, operators };
}

function pkgFrom(text: string): AvailabilityPackage {
  const parsed = parseScheduleText(text);
  return {
    id: 'pkg1',
    rawText: text,
    entries: parsed.entries,
    names: [...new Set(parsed.entries.map((e) => e.name))],
    weekdays: [...new Set(parsed.entries.map((e) => e.weekday))].sort((a, b) => a - b),
    warnings: [],
    active: true,
    createdAt: new Date().toISOString(),
  };
}

// ---- 解析器 ----
console.log('parser:');
{
  const r = parseScheduleText('周一 霍连生 08:00-12:00\n周一 苗凤仪 8点半-11点半\n周二 裴三保、闻小楼 14:00 至 17:00\n乱码一行\n周三 无名 09:00');
  check('识别 4 条有效记录', r.entries.length === 4, `got ${r.entries.length}`);
  check('8点半=08:30', r.entries[1].startMinute === 30 && r.entries[1].endMinute === 210, JSON.stringify(r.entries[1]));
  check('顿号多人拆两行', r.entries.filter((e) => e.name === '裴三保' || e.name === '闻小楼').length === 2);
  check('坏行进入 warnings', r.warnings.some((w) => w.line === 4), JSON.stringify(r.warnings));
  check('无时段行也进入 warnings', r.warnings.some((w) => w.line === 5));
  check('结束早于开始丢弃并报错', parseScheduleText('周一 霍连生 11:00-10:00').entries.length === 0);
}

// ---- 推算器：正常落位 + 同剧首尾相接 + 跨戏避让 ----
console.log('planner happy path:');
{
  const basis = mkBasis();
  const pkg = pkgFrom('周一 霍连生 08:00-18:00\n周一 苗凤仪 08:00-18:00\n周一 裴三保 08:00-18:00');
  const planned = planRehearsal(pkg, basis);
  check('共 3 场', planned.length === 3);
  const [a1, a2, b1] = planned;
  check('甲一场周一 08:00 起', a1.weekday === 1 && a1.startMinute === 0 && a1.endMinute === 60, JSON.stringify({ w: a1.weekday, s: a1.startMinute }));
  check('甲二场与甲一场首尾相接 09:00', a2.weekday === 1 && a2.startMinute === 60, JSON.stringify({ w: a2.weekday, s: a2.startMinute }));
  check('乙一场（霍连生）避开甲一场，09:00 起', b1.weekday === 1 && b1.startMinute === 60, JSON.stringify({ w: b1.weekday, s: b1.startMinute }));
  check('甲二场占用含领奏裴三保', a2.occupied.some((p) => p.operatorId === 'o3' && p.kinds.includes('lead')));
}

// ---- 缺到场记录 = 待补，不是空闲 ----
console.log('missing records => pending:');
{
  const basis = mkBasis();
  // 只给霍连生记录；甲二场需要苗凤仪+裴三保，乙一场只要霍连生
  const pkg = pkgFrom('周一 霍连生 08:00-18:00');
  const planned = planRehearsal(pkg, basis);
  const a2 = planned.find((p) => p.scene.id === 's2');
  const b1 = planned.find((p) => p.scene.id === 's3');
  check('缺记录场次标 pending', a2?.status === 'pending', a2?.status ?? '');
  check('pending 理由点明缺记录且非空闲', a2?.reason.includes('缺') && a2.reason.includes('到场记录') && a2.reason.includes('空闲'));
  check('只有霍连生的乙一场仍能落位', b1?.status === 'unconfirmed' && b1.weekday === 1);
}

// ---- 有记录但窗口装不下 = blocked ----
console.log('window too small => blocked:');
{
  const basis = mkBasis();
  // 三人每天都有记录但窗口都只有 30 分钟：有记录却排不下 => blocked
  const lines = ['霍连生', '苗凤仪', '裴三保'].flatMap((name) =>
    ['一', '二', '三', '四', '五'].map((d) => `周${d} ${name} 08:00-08:30`),
  );
  const pkg = pkgFrom(lines.join('\n'));
  const planned = planRehearsal(pkg, basis);
  const a1 = planned.find((p) => p.scene.id === 's1');
  check('60 分钟戏、30 分钟窗口 => blocked', a1?.status === 'blocked', a1?.status ?? '');
}

// ---- 窗口交集为空（有人下午有人上午） => blocked ----
console.log('disjoint windows => blocked:');
{
  const basis = mkBasis();
  const lines = [
    ...['一', '二', '三', '四', '五'].flatMap((d) => [
      `周${d} 霍连生 08:00-09:00`,
      `周${d} 苗凤仪 14:00-15:00`,
      `周${d} 裴三保 08:00-18:00`,
    ]),
  ].join('\n');
  const pkg = pkgFrom(lines);
  // 构造一场同时占用霍与苗的戏
  basis.roles.push({ ...basis.roles[0], id: 'rx', sceneId: 's1', name: '角色X', operatorId: 'o2' });
  const planned = planRehearsal(pkg, basis);
  const a1 = planned.find((p) => p.scene.id === 's1');
  check('窗口无交集 => blocked', a1?.status === 'blocked', a1?.status ?? '');
}

// ---- 已确认旧依据保留 + 与新排场次冲突检测 ----
console.log('confirmed legacy + conflicts:');
{
  const basis = mkBasis();
  const pkg = pkgFrom('周一 霍连生 08:00-18:00\n周一 苗凤仪 08:00-18:00\n周一 裴三保 08:00-18:00');
  const rows = toSessionRows(planRehearsal(pkg, basis), 'pkg2');
  // 模拟乙一场是旧包里已确认的场次，时间钉在周一 08:00-09:00（与新甲一场撞）
  const b1 = rows.find((r) => r.sceneId === 's3');
  b1.status = 'confirmed';
  b1.weekday = 1;
  b1.startMinute = 0;
  b1.endMinute = 60;
  b1.packageId = 'old-pkg';
  const conflicts = detectSessionConflicts(rows);
  check('霍连生同时被排甲乙两戏 => 两场都标冲突', (conflicts.get(b1.id)?.length ?? 0) >= 1);
  const a1 = rows.find((r) => r.sceneId === 's1');
  check('甲一场也在冲突列表', (conflicts.get(a1!.id)?.length ?? 0) >= 1);
}

// ---- 依据签名随指派/时长变化 ----
console.log('basis signature:');
{
  const basis = mkBasis();
  const sig1 = buildBasisSignature(basis, 'p1');
  basis.scenes[0].durationMin = 90;
  const sig2 = buildBasisSignature(basis, 'p1');
  check('时长变化签名变', sig1 !== sig2);
  basis.scenes[0].durationMin = 60;
  basis.roles[0].operatorId = 'o2';
  const sig3 = buildBasisSignature(basis, 'p1');
  check('指派变化签名变', sig1 !== sig3);
}

// ---- 未指派角色不算硬占用，但要在占用列表暴露 ----
console.log('unassigned role:');
{
  const basis = mkBasis();
  basis.roles[0].operatorId = null;
  const occupied = collectOccupied('s1', basis);
  check('未指派角色以「待指派」占位暴露', occupied.some((p) => p.name === '待指派'));
  const pkg = pkgFrom('周一 苗凤仪 08:00-18:00\n周一 裴三保 08:00-18:00');
  const planned = planRehearsal(pkg, basis);
  const s1 = planned.find((p) => p.scene.id === 's1');
  check('无任何已派操耍人的场次不被待补阻塞，能落位', s1?.status === 'unconfirmed', s1?.status ?? '');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);

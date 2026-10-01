/**
 * 连排推算器
 * 规则：
 * - 日程包只提供「到场事实」（谁、哪天、几点到几点）；
 * - 本地场序决定每个剧目的场次先后，场次时长决定每场起止（同剧连排、首尾相接）；
 * - 角色操耍人（role.operatorId）与锣鼓点领奏（cue.leadOperator）都算占用，同人去重；
 * - 某占用人员当天「没有任何到场记录」→ 该日不可用，绝不当作空闲；
 *   所有排练日都因缺记录排不下 → 待补（pending）；有记录但窗口装不下或撞戏 → 受阻（blocked）；
 * - 两出戏占用同一人、时刻重叠 → 冲突。
 */
import type { OperatorRow, PlayRow, RoleRow, SceneRow, CueRow } from './db';
import { ROW_REVISION } from './db';
import type { JointSessionRow } from './db';
import type {
  AvailabilityEntry,
  AvailabilityPackage,
  JointSession,
  OccupationKind,
  OccupiedPerson,
} from '../types/rehearsal';
import { BEAT_NAME_LABEL } from '../types/cue';
import { nowIso, uuid } from './uuid';

/** 推算所需的本地数据全集 */
export interface LocalBasis {
  plays: PlayRow[];
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
}

interface WindowRange {
  startMinute: number;
  endMinute: number;
}

/** 某人某天的到场窗口（同天多条记录取并集，重叠/相邻则合并） */
function windowsOf(entries: AvailabilityEntry[], name: string, weekday: number): WindowRange[] {
  const ranges = entries
    .filter((entry) => entry.name === name && entry.weekday === weekday)
    .map((entry) => ({ startMinute: entry.startMinute, endMinute: entry.endMinute }))
    .sort((a, b) => a.startMinute - b.startMinute);
  const merged: WindowRange[] = [];
  ranges.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, range.endMinute);
    } else {
      merged.push({ ...range });
    }
  });
  return merged;
}

/** 多组窗口的交集 */
function intersectWindows(groups: WindowRange[][]): WindowRange[] {
  if (groups.length === 0) return [];
  let common = [...groups[0]];
  groups.slice(1).forEach((group) => {
    const next: WindowRange[] = [];
    common.forEach((a) => {
      group.forEach((b) => {
        const start = Math.max(a.startMinute, b.startMinute);
        const end = Math.min(a.endMinute, b.endMinute);
        if (end > start) next.push({ startMinute: start, endMinute: end });
      });
    });
    common = next.sort((x, y) => x.startMinute - y.startMinute);
  });
  return common;
}

/** 收集一场戏的占用人员（角色操耍人 + 锣鼓点领奏，同人合并） */
export function collectOccupied(sceneId: string, basis: LocalBasis): OccupiedPerson[] {
  const byOperator = new Map<string, OccupiedPerson>();
  let hasUnassigned = false;

  basis.roles
    .filter((role) => role.sceneId === sceneId)
    .forEach((role) => {
      if (role.operatorId === null) {
        hasUnassigned = true;
        return;
      }
      const person = basis.operators.find((operator) => operator.id === role.operatorId);
      const item =
        byOperator.get(role.operatorId) ??
        ({
          operatorId: role.operatorId,
          name: person?.name ?? '（已解绑）',
          kinds: [],
          refs: [],
        } as OccupiedPerson);
      if (!item.kinds.includes('role')) item.kinds.push('role');
      item.refs.push(role.name);
      byOperator.set(role.operatorId, item);
    });

  basis.cues
    .filter((cue) => cue.sceneId === sceneId)
    .forEach((cue) => {
      if (cue.leadOperator === null) return;
      const person = basis.operators.find((operator) => operator.id === cue.leadOperator);
      const item =
        byOperator.get(cue.leadOperator) ??
        ({
          operatorId: cue.leadOperator,
          name: person?.name ?? '（已解绑）',
          kinds: [],
          refs: [],
        } as OccupiedPerson);
      if (!item.kinds.includes('lead')) item.kinds.push('lead' as OccupationKind);
      item.refs.push(`${BEAT_NAME_LABEL[cue.beatName]}领奏`);
      byOperator.set(cue.leadOperator, item);
    });

  const people = [...byOperator.values()];
  if (hasUnassigned) {
    people.push({ operatorId: null, name: '待指派', kinds: ['role'], refs: ['本场尚有角色未派操耍人'] });
  }
  return people;
}

/**
 * 本地依据签名：参与一个剧目的场序、时长、角色操耍人、领奏。
 * 签名变化即代表未确认场次依据失效。
 */
export function buildBasisSignature(basis: LocalBasis, playId: string): string {
  const scenes = basis.scenes
    .filter((scene) => scene.playId === playId)
    .sort((a, b) => a.seq - b.seq);
  const parts = scenes.map((scene) => {
    const roleBindings = basis.roles
      .filter((role) => role.sceneId === scene.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((role) => `${role.name}:${role.operatorId ?? '∅'}`)
      .join('|');
    const leadBindings = basis.cues
      .filter((cue) => cue.sceneId === scene.id)
      .sort((a, b) => a.atSecond - b.atSecond)
      .map((cue) => `${cue.atSecond}:${cue.leadOperator ?? '∅'}`)
      .join('|');
    return `${scene.seq}=${scene.durationMin}[${roleBindings}]{${leadBindings}}`;
  });
  return `${playId}::${parts.join('//')}`;
}

/** 人类可读的依据快照，已确认场次在依据过期后据此展示「旧依据」 */
export function buildBasisSnapshot(basis: LocalBasis, playId: string): string {
  const play = basis.plays.find((item) => item.id === playId);
  const scenes = basis.scenes
    .filter((scene) => scene.playId === playId)
    .sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  if (play) lines.push(`剧目《${play.title}》共 ${scenes.length} 场`);
  scenes.forEach((scene) => {
    const people = collectOccupied(scene.id, basis);
    const who = people.map((person) => `${person.name}（${person.kinds.join('+')}）`).join('、') || '无占用';
    lines.push(`第${scene.seq}场 ${scene.durationMin}分钟｜${who}`);
  });
  return lines.join('\n');
}

interface Placement {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** 已落下的占用：某人某天已被占用的区间（用于跨戏冲突扫描） */
type OccupiedCalendar = Map<string, WindowRange[]>; // key: operatorId|weekday

function calendarKey(operatorId: string, weekday: number): string {
  return `${operatorId}|${weekday}`;
}

function addOccupation(calendar: OccupiedCalendar, operatorId: string, weekday: number, range: WindowRange): void {
  const key = calendarKey(operatorId, weekday);
  const list = calendar.get(key) ?? [];
  list.push(range);
  calendar.set(key, list);
}

/** 该区间与某人某天已有占用是否重叠 */
function collides(calendar: OccupiedCalendar, operatorId: string, weekday: number, range: WindowRange): boolean {
  const list = calendar.get(calendarKey(operatorId, weekday)) ?? [];
  return list.some((item) => range.startMinute < item.endMinute && item.startMinute < range.endMinute);
}

/** 扫描某日，在交叠窗口内找一段不撞戏的连续空档；找不到返回 null */
function findFreeStart(
  calendar: OccupiedCalendar,
  operatorIds: string[],
  weekday: number,
  windows: WindowRange[],
  duration: number,
): number | null {
  for (const win of windows) {
    // 候选起点：窗口开头，以及任一占用者当天已有占用的结束点
    const blockedEnds = operatorIds.flatMap((id) =>
      (calendar.get(calendarKey(id, weekday)) ?? []).map((item) => item.endMinute),
    );
    const candidates = [win.startMinute, ...blockedEnds]
      .filter((start) => start >= win.startMinute && start + duration <= win.endMinute)
      .sort((a, b) => a - b);
    for (const start of candidates) {
      const range = { startMinute: start, endMinute: start + duration };
      if (operatorIds.every((id) => !collides(calendar, id, weekday, range))) return start;
    }
  }
  return null;
}

export type PlanOutcome =
  | { kind: 'placed'; placement: Placement }
  | { kind: 'pending'; reason: string }
  | { kind: 'blocked'; reason: string };

/**
 * 给一场戏找落位。按周一到周日逐日试：
 * - 当天缺任何人到场记录 → 该日跳过（缺记录绝不当空闲）；
 * - 有完整记录但窗口交不下或撞戏 → 记为硬排不进；
 * 只要存在「有完整记录却排不进」的日子 → blocked；
 * 全部日子都因缺记录无法评估 → pending（需向外班补到场事实）。
 */
export function planScene(
  pkg: AvailabilityPackage,
  scene: SceneRow,
  people: OccupiedPerson[],
  calendar: OccupiedCalendar,
  preferredStart?: { weekday: number; startMinute: number },
): PlanOutcome {
  const duration = Math.max(1, Math.round(scene.durationMin));
  const assigned = people.filter((person) => person.operatorId !== null);
  const operatorIds = assigned.map((person) => person.operatorId as string);
  const operatorNames = new Map(assigned.map((person) => [person.operatorId as string, person.name]));

  // 没有任何已派操耍人的场次：没有占用约束，按场序从周一 08:00 起排入
  if (operatorIds.length === 0) {
    return { kind: 'placed', placement: { weekday: 0, startMinute: 0, endMinute: duration } };
  }

  const missingNames = new Set<string>();
  const hardFailures: string[] = [];

  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const weekdayName = `周${'日一二三四五六'[weekday]}`;
    const missing = operatorIds.filter((id) => windowsOf(pkg.entries, operatorNames.get(id) ?? '', weekday).length === 0);
    if (missing.length > 0) {
      missing.forEach((id) => missingNames.add(operatorNames.get(id) ?? ''));
      continue;
    }
    const groups = operatorIds.map((id) => windowsOf(pkg.entries, operatorNames.get(id) ?? '', weekday));
    const common = intersectWindows(groups);
    if (common.length === 0) {
      hardFailures.push(`${weekdayName}各人到场窗口无交集`);
      continue;
    }

    // 优先尝试上一场留下的接续位置（同剧首尾相接）
    let windows = common;
    if (preferredStart && preferredStart.weekday === weekday) {
      const clipped = common
        .map((win) => {
          const start = Math.max(win.startMinute, preferredStart.startMinute);
          return { startMinute: start, endMinute: win.endMinute };
        })
        .filter((win) => win.endMinute - win.startMinute >= duration);
      if (clipped.length > 0) windows = clipped;
    }

    const start = findFreeStart(calendar, operatorIds, weekday, windows, duration);
    if (start !== null) {
      return { kind: 'placed', placement: { weekday, startMinute: start, endMinute: start + duration } };
    }
    hardFailures.push(`${weekdayName}有到场记录但窗口内排不下 ${duration} 分钟（撞戏或窗口不足）`);
  }

  if (hardFailures.length > 0) {
    return { kind: 'blocked', reason: hardFailures[0] };
  }
  const who = missingNames.size > 0 ? `：${[...missingNames].join('、')}` : '';
  return {
    kind: 'pending',
    reason: `占用人员在日程包内缺少到场记录${who}，需向外班补录；缺记录不等于空闲`,
  };
}

/** 落位结果（不含落库字段） */
export interface PlannedSession {
  scene: SceneRow;
  play: PlayRow;
  occupied: OccupiedPerson[];
  status: JointSession['status'];
  weekday: number | null;
  startMinute: number | null;
  endMinute: number | null;
  reason: string;
  basisWindows: JointSession['basisWindows'];
  basisSignature: string;
  basisSnapshot: string;
}

/**
 * 依据一个日程包，对指定剧目（未给则全部）做整轮连排推算。
 * 同剧目按场序首尾相接；跨剧目占用同一人时，后排的戏避开先排的戏。
 */
export function planRehearsal(
  pkg: AvailabilityPackage,
  basis: LocalBasis,
  playIds?: string[],
): PlannedSession[] {
  const scopedPlays = basis.plays
    .filter((play) => !playIds || playIds.includes(play.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const calendar: OccupiedCalendar = new Map();
  const results: PlannedSession[] = [];

  scopedPlays.forEach((play) => {
    const scenes = basis.scenes
      .filter((scene) => scene.playId === play.id)
      .sort((a, b) => a.seq - b.seq);
    const signature = buildBasisSignature(basis, play.id);
    const snapshot = buildBasisSnapshot(basis, play.id);
    // 上一场结束位置：同剧下一场默认从这里接
    let cursor: { weekday: number; startMinute: number } | null = null;

    scenes.forEach((scene) => {
      const occupied = collectOccupied(scene.id, basis);
      const outcome = planScene(pkg, scene, occupied, calendar, cursor ?? undefined);
      const basisWindows =
        outcome.kind === 'placed'
          ? occupied
              .filter((person) => person.operatorId !== null)
              .flatMap((person) =>
                windowsOf(pkg.entries, person.name, outcome.placement.weekday).map((win) => ({
                  name: person.name,
                  weekday: outcome.placement.weekday as JointSession['basisWindows'][number]['weekday'],
                  startMinute: win.startMinute,
                  endMinute: win.endMinute,
                })),
              )
          : [];

      if (outcome.kind === 'placed') {
        const { weekday, startMinute, endMinute } = outcome.placement;
        occupied
          .filter((person) => person.operatorId !== null)
          .forEach((person) => {
            addOccupation(calendar, person.operatorId as string, weekday, { startMinute, endMinute });
          });
        cursor = { weekday, startMinute: endMinute };
        results.push({
          scene,
          play,
          occupied,
          status: 'unconfirmed',
          weekday,
          startMinute,
          endMinute,
          reason: '',
          basisWindows,
          basisSignature: signature,
          basisSnapshot: snapshot,
        });
      } else {
        cursor = null;
        results.push({
          scene,
          play,
          occupied,
          status: outcome.kind,
          weekday: null,
          startMinute: null,
          endMinute: null,
          reason: outcome.reason,
          basisWindows: [],
          basisSignature: signature,
          basisSnapshot: snapshot,
        });
      }
    });
  });

  return results;
}

/** 把推算结果转成待写库的连排场次行 */
export function toSessionRows(planned: PlannedSession[], packageId: string): JointSessionRow[] {
  const stamp = nowIso();
  return planned.map((item) => ({
    id: uuid(),
    packageId,
    sceneId: item.scene.id,
    playId: item.play.id,
    playTitle: item.play.title,
    seq: item.scene.seq,
    sceneTitle: item.scene.title,
    durationMin: item.scene.durationMin,
    weekday: item.weekday as JointSessionRow['weekday'],
    startMinute: item.startMinute,
    endMinute: item.endMinute,
    status: item.status,
    occupied: item.occupied,
    reason: item.reason,
    basisWindows: item.basisWindows,
    basisSignature: item.basisSignature,
    basisSnapshot: item.basisSnapshot,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }));
}

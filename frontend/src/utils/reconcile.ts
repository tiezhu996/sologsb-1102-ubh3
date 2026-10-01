/**
 * 连排对账计算引擎（纯函数）
 *
 * 输入：计划、折子锚点、本地场序/时长、角色与领奏指派、操耍人档、当前依据包到场事实；
 * 输出：每个场次的对账行结论（ok / needInfo / conflict）与冻结依据快照。
 *
 * 口径：
 * - 日程包只提供「姓名 + 可到场时段」事实，不决定场次起止；
 * - 场次起止由本地场序与时长从折子锚点顺序累加；
 * - 角色操耍人与锣鼓点领奏都算占用；
 * - 包内查无到场记录 → missingRecord（待补），绝不能当作空闲；
 * - 同一操耍人同一时刻落在两出戏 → doubleBooked（冲突）。
 */
import type {
  AttendanceFact,
  EvidenceWindowGroup,
  OccupantRef,
  PlanBlock,
  ReconEntry,
  ReconEvidence,
  ReconProblem,
  RehearsalPlan,
} from '../types/rehearsal';
import type { OperatorRow, RoleRow, CueRow, SceneRow } from '../utils/db';
import { BEAT_NAME_LABEL } from '../types/cue';
import { secondsToTimecode } from './timecode';
import { nowIso, uuid } from './uuid';

/** 参与计算的本地数据集合 */
export interface ReconInput {
  plan: RehearsalPlan;
  blocks: PlanBlock[];
  /** blockId → 该折子下按场序排好的场次 */
  scenesByBlock: Map<string, SceneRow[]>;
  /** sceneId → 角色 */
  rolesByScene: Map<string, RoleRow[]>;
  /** sceneId → 锣鼓点 */
  cuesByScene: Map<string, CueRow[]>;
  operators: OperatorRow[];
  /** 当前依据包到场事实（已按计划星期过滤与否由调用方决定，这里再过滤一次） */
  facts: AttendanceFact[];
  /** 依据包名 */
  packLabel: string;
}

/** 计划内排好的一个场次槽位 */
interface SceneSlot {
  blockId: string;
  scene: SceneRow;
  startMinute: number;
  endMinute: number;
  sortIndex: number;
}

/** 展开折子锚点 + 本地场序时长，得到每场起止 */
export function expandSlots(blocks: PlanBlock[], scenesByBlock: Map<string, SceneRow[]>): SceneSlot[] {
  const slots: SceneSlot[] = [];
  const orderedBlocks = [...blocks].sort((a, b) => a.sortOrder - b.sortOrder);
  let sortIndex = 0;
  orderedBlocks.forEach((block) => {
    const scenes = (scenesByBlock.get(block.id) ?? []).slice().sort((a, b) => a.seq - b.seq);
    let cursor = block.anchorStartMinute;
    scenes.forEach((scene) => {
      const duration = Number.isFinite(scene.durationMin) ? Math.max(0, scene.durationMin) : 0;
      slots.push({ blockId: block.id, scene, startMinute: cursor, endMinute: cursor + duration, sortIndex });
      cursor += duration;
      sortIndex += 1;
    });
  });
  return slots;
}

/** 汇总一场的占用：角色 + 领奏 */
function occupantsOf(
  sceneId: string,
  rolesByScene: Map<string, RoleRow[]>,
  cuesByScene: Map<string, CueRow[]>,
  operatorName: Map<string, string>,
): OccupantRef[] {
  const occupants: OccupantRef[] = [];
  (rolesByScene.get(sceneId) ?? []).forEach((role) => {
    occupants.push({
      kind: 'role',
      refId: role.id,
      label: `角色·${role.name}`,
      operatorId: role.operatorId,
      operatorName: role.operatorId ? operatorName.get(role.operatorId) ?? '（已解绑）' : '待指派',
    });
  });
  (cuesByScene.get(sceneId) ?? [])
    .slice()
    .sort((a, b) => a.atSecond - b.atSecond)
    .forEach((cue) => {
      occupants.push({
        kind: 'cue',
        refId: cue.id,
        label: `领奏·${BEAT_NAME_LABEL[cue.beatName]} ${secondsToTimecode(cue.atSecond)}`,
        operatorId: cue.leadOperator,
        operatorName: cue.leadOperator ? operatorName.get(cue.leadOperator) ?? '（已解绑）' : '待指派',
      });
    });
  return occupants;
}

function rangesOverlap(a: SceneSlot, b: SceneSlot): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

export interface RecomputedEntry {
  slot: SceneSlot;
  entry: Omit<ReconEntry, 'id' | 'createdAt'>;
}

/**
 * 重算全部场次（调用方负责按确认状态决定是否落库）：
 * 返回按场序排好的全新行内容，已确认行不参与（由调用方原样保留）。
 */
export function recomputeEntries(input: ReconInput): RecomputedEntry[] {
  const operatorName = new Map<string, string>();
  const operatorByName = new Map<string, OperatorRow>();
  input.operators.forEach((operator) => {
    operatorName.set(operator.id, operator.name);
    operatorByName.set(operator.name, operator);
  });

  // 依据包中「姓名 → 当日窗口」（只取本计划排练日的事实）
  const windowsByName = new Map<string, Array<{ startMinute: number; endMinute: number; rawText: string }>>();
  input.facts
    .filter((fact) => fact.weekday === input.plan.weekday)
    .forEach((fact) => {
      const list = windowsByName.get(fact.personName) ?? [];
      list.push({ startMinute: fact.startMinute, endMinute: fact.endMinute, rawText: fact.rawText });
      windowsByName.set(fact.personName, list);
    });

  const slots = expandSlots(input.blocks, input.scenesByBlock);

  // 先收集每场占用，再统一判跨戏撞档
  const occupantsByScene = new Map<string, OccupantRef[]>();
  slots.forEach((slot) => {
    occupantsByScene.set(
      slot.scene.id,
      occupantsOf(slot.scene.id, input.rolesByScene, input.cuesByScene, operatorName),
    );
  });

  // operatorId → 出现的槽位（跨折子才算两出戏）
  const slotsByOperator = new Map<string, SceneSlot[]>();
  slots.forEach((slot) => {
    const operatorIds = new Set(
      (occupantsByScene.get(slot.scene.id) ?? [])
        .map((occupant) => occupant.operatorId)
        .filter((id): id is string => id !== null),
    );
    operatorIds.forEach((operatorId) => {
      const list = slotsByOperator.get(operatorId) ?? [];
      list.push(slot);
      slotsByOperator.set(operatorId, list);
    });
  });

  const stamp = nowIso();

  return slots.map((slot) => {
    const occupants = occupantsByScene.get(slot.scene.id) ?? [];
    const problems: ReconProblem[] = [];

    occupants.forEach((occupant) => {
      if (occupant.operatorId === null) {
        problems.push({ kind: 'unassigned', text: `${occupant.label} 尚未指派操耍人，到场无法核对` });
        return;
      }
      // 按姓名去外班包里查到场记录；查无记录 = 待补，不是空闲
      const windows = windowsByName.get(occupant.operatorName);
      if (!windows || windows.length === 0) {
        problems.push({
          kind: 'missingRecord',
          text: `${occupant.operatorName}（${occupant.label}）在日程包中无${weekdayText(input.plan.weekday)}到场记录，标记待补`,
        });
        return;
      }
      const covered = windows.some(
        (window) => window.startMinute <= slot.startMinute && slot.endMinute <= window.endMinute,
      );
      if (!covered) {
        const nearest = windows
          .map((window) => `${window.rawText.replace(/\s+/g, ' ')}`)
          .join('；');
        problems.push({
          kind: 'coverageGap',
          text: `${occupant.operatorName}（${occupant.label}）到场窗口不能完整覆盖本场：${nearest}`,
        });
      }
    });

    // 跨戏撞档：同一操耍人在重叠时刻出现在不同折子
    const seenPair = new Set<string>();
    occupants.forEach((occupant) => {
      if (occupant.operatorId === null) return;
      const others = (slotsByOperator.get(occupant.operatorId) ?? []).filter(
        (other) => other.blockId !== slot.blockId && rangesOverlap(slot, other),
      );
      others.forEach((other) => {
        const pairKey = [occupant.operatorId, slot.scene.id, other.scene.id].sort().join('|');
        if (seenPair.has(pairKey)) return;
        seenPair.add(pairKey);
        problems.push({
          kind: 'doubleBooked',
          text: `${occupant.operatorName} 在同一时刻被排进《${other.scene.title}》（${occupant.label}）`,
          otherSceneId: other.scene.id,
          otherSceneTitle: other.scene.title,
        });
      });
    });

    const hasConflict = problems.some((problem) => problem.kind === 'doubleBooked');
    const hasNeedInfo = problems.some((problem) => problem.kind !== 'doubleBooked');
    const status = hasConflict ? 'conflict' : hasNeedInfo ? 'needInfo' : 'ok';

    // 冻结依据：本场所涉操耍人在依据包内的全部到场窗口
    const referencedOperatorIds = new Set(
      occupants.map((occupant) => occupant.operatorId).filter((id): id is string => id !== null),
    );
    const windowsByOperator: EvidenceWindowGroup[] = [];
    referencedOperatorIds.forEach((operatorId) => {
      const name = operatorName.get(operatorId) ?? '';
      const facts = windowsByName.get(name) ?? [];
      windowsByOperator.push({
        operatorId,
        operatorName: name,
        windows: facts.map((fact) => ({
          weekday: input.plan.weekday,
          startMinute: fact.startMinute,
          endMinute: fact.endMinute,
          rawText: fact.rawText,
        })),
      });
    });

    const evidence: ReconEvidence = {
      packId: input.plan.activePackId,
      packLabel: input.packLabel,
      weekday: input.plan.weekday,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      occupants,
      windowsByOperator,
      computedAt: stamp,
    };

    return {
      slot,
      entry: {
        planId: input.plan.id,
        blockId: slot.blockId,
        sceneId: slot.scene.id,
        weekday: input.plan.weekday,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        status,
        problems,
        confirmed: false,
        dirty: false,
        confirmedAt: null,
        evidence,
        updatedAt: stamp,
      },
    };
  });
}

/** 为新计划/折子/行生成主键 */
export function newReconId(prefix: string): string {
  return `${prefix}-${uuid()}`;
}

function weekdayText(weekday: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? '当日';
}

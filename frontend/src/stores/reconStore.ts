/**
 * 连排对账状态管理（Zustand）
 *
 * 关键约束：
 * - 导入日程包 + 依据包切换 + 未确认行重算必须在同一个 Dexie 事务里，写入不能留半套；
 *   解析失败 / 事务失败都不碰库里的旧数据，草稿保留在 localStorage 里可原样重试。
 * - 已确认场次在任何重算中原样保留（冻结旧包 id 与旧窗口依据）；
 * - 未确认场次每次依据变化整行重算，缺失场次的行在事务内删除。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  db,
  listBlocksByPlan,
  listEntriesByPlan,
  listPacks,
  listAllFacts,
  listAllRoles,
  listOperators,
  type AttendanceFactRow,
  type AttendancePackRow,
  type CueRow,
  type OperatorRow,
  type PlanBlockRow,
  type PlayRow,
  type ReconEntryRow,
  type RehearsalPlanRow,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import { DEFAULT_PLAN_NAME, DEFAULT_RECON_WEEKDAY } from '../types/rehearsal';
import { parseAttendancePack } from '../utils/attendanceParser';
import { recomputeEntries, type ReconInput } from '../utils/reconcile';
import { STORAGE_KEYS, readLocal, writeLocal } from '../utils/localStore';
import { nowIso, uuid } from '../utils/uuid';

/** 一次导入的结果（页面用于提示） */
export interface PackImportResult {
  packId: string;
  personCount: number;
  factCount: number;
  label: string;
  warnings: string[];
}

interface ReconStoreState {
  loading: boolean;
  error: string;
  plan: RehearsalPlanRow | null;
  blocks: PlanBlockRow[];
  entries: ReconEntryRow[];
  packs: AttendancePackRow[];
  facts: AttendanceFactRow[];
  plays: PlayRow[];
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
  /** 待确认区草稿原文（解析/写入失败后保留） */
  draftText: string;
  loadRecon: () => Promise<void>;
  setDraftText: (text: string) => void;
  clearDraft: () => void;
  setWeekday: (weekday: RehearsalPlanRow['weekday']) => Promise<void>;
  renamePlan: (name: string) => Promise<void>;
  upsertBlock: (playId: string, anchorStartMinute: number) => Promise<void>;
  removeBlock: (blockId: string) => Promise<void>;
  importPack: (text: string, label?: string) => Promise<PackImportResult>;
  deletePack: (packId: string) => Promise<void>;
  activatePack: (packId: string) => Promise<void>;
  confirmEntry: (entryId: string) => Promise<void>;
  unconfirmEntry: (entryId: string) => Promise<void>;
  recompute: (options?: RecomputeOptions) => Promise<void>;
}

/** 重算选项：可在同一事务内先改计划字段或解冻若干已确认行 */
export interface RecomputeOptions {
  planPatch?: Partial<Pick<RehearsalPlanRow, 'weekday' | 'name' | 'activePackId'>>;
  unconfirmEntryIds?: string[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function defaultPackLabel(): string {
  const date = new Date();
  return `外班日程包 ${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;
}

/** 读取或创建单例连排计划（事务内幂等） */
async function ensurePlanRow(): Promise<RehearsalPlanRow> {
  return db.transaction('rw', db.rehearsalPlans, async () => {
    const existing = await db.rehearsalPlans.toCollection().first();
    if (existing) return existing;
    const stamp = nowIso();
    const row: RehearsalPlanRow = {
      id: uuid(),
      name: DEFAULT_PLAN_NAME,
      weekday: DEFAULT_RECON_WEEKDAY,
      activePackId: null,
      active: true,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.rehearsalPlans.put(row);
    return row;
  });
}

interface BuiltEntries {
  /** 重算后应保留的全部行（已确认冻结 + 未确认重算） */
  next: ReconEntryRow[];
  /** 场次已不在折子中的未确认行，需在事务内删除 */
  removedUnconfirmed: ReconEntryRow[];
}

/** 组装计算引擎输入并执行重算，返回应落库的全部行（已确认行原样保留） */
async function buildNextEntries(
  plan: RehearsalPlanRow,
  blocks: PlanBlockRow[],
  existingEntriesInput: ReconEntryRow[],
  unconfirmIds: ReadonlySet<string> = new Set(),
): Promise<BuiltEntries> {
  // 本次解冻的行按未确认处理（旧冻结行不再进确认列表）
  const existingEntries = existingEntriesInput.map((entry) =>
    unconfirmIds.has(entry.id)
      ? { ...entry, confirmed: false, confirmedAt: null, updatedAt: nowIso(), revision: ROW_REVISION }
      : entry,
  );
  const [scenes, roles, cues, operators, facts] = await Promise.all([
    db.scenes.toArray(),
    db.roles.toArray(),
    db.cues.toArray(),
    db.operators.toArray(),
    plan.activePackId ? db.attendanceFacts.where('packId').equals(plan.activePackId).toArray() : Promise.resolve([]),
  ]);
  const pack = plan.activePackId ? await db.attendancePacks.get(plan.activePackId) : undefined;

  const scenesByBlock = new Map<string, SceneRow[]>();
  blocks.forEach((block) => {
    scenesByBlock.set(block.id, scenes.filter((scene) => scene.playId === block.playId));
  });
  const rolesByScene = new Map<string, RoleRow[]>();
  roles.forEach((role) => {
    const list = rolesByScene.get(role.sceneId) ?? [];
    list.push(role);
    rolesByScene.set(role.sceneId, list);
  });
  const cuesByScene = new Map<string, CueRow[]>();
  cues.forEach((cue) => {
    const list = cuesByScene.get(cue.sceneId) ?? [];
    list.push(cue);
    cuesByScene.set(cue.sceneId, list);
  });

  const input: ReconInput = {
    plan,
    blocks,
    scenesByBlock,
    rolesByScene,
    cuesByScene,
    operators,
    facts,
    packLabel: pack?.label ?? '（无到场包）',
  };

  const recomputed = recomputeEntries(input);
  const recomputedByKey = new Map(
    recomputed.map((item) => [`${item.slot.blockId}|${item.slot.scene.id}`, item]),
  );

  const next: ReconEntryRow[] = existingEntries.filter((entry) => entry.confirmed).map((entry) => {
    // 已确认行保留旧依据；仅在依赖变化时置 dirty（提示「依据已更新」），结论与证据一律不改
    const live = recomputedByKey.get(`${entry.blockId}|${entry.sceneId}`);
    const frozenSig = frozenSignature(entry);
    const liveSig = live
      ? liveSignature(live, liveCrossConflicts(live, recomputed))
      : `removed:${entry.blockId}|${entry.sceneId}`;
    const isDirty = frozenSig !== liveSig;
    if (isDirty === entry.dirty) return entry;
    return { ...entry, dirty: isDirty, updatedAt: nowIso(), revision: ROW_REVISION };
  });

  recomputed.forEach((item) => {
    const previous = existingEntries.find(
      (entry) => !entry.confirmed && entry.sceneId === item.slot.scene.id && entry.blockId === item.slot.blockId,
    );
    next.push({
      ...item.entry,
      id: previous?.id ?? uuid(),
      createdAt: previous?.createdAt ?? nowIso(),
      revision: ROW_REVISION,
    });
  });

  // 未确认行里凡是本场次已不在任何折子中的，删除
  const keepIds = new Set(next.map((entry) => entry.id));
  const removedUnconfirmed = existingEntries.filter((entry) => !entry.confirmed && !keepIds.has(entry.id));
  return { next, removedUnconfirmed };
}

/** 已确认行冻结依据的指纹：包、星期、起止、占用指派与当时问题文案 */
function frozenSignature(entry: ReconEntryRow): string {
  const evidence = entry.evidence;
  const occupantPart = evidence
    ? evidence.occupants
        .map((occupant) => `${occupant.kind}:${occupant.refId}=${occupant.operatorId ?? 'none'}`)
        .sort()
        .join(',')
    : '';
  const problemPart = entry.problems.map((problem) => `${problem.kind}:${problem.text}`).sort().join('||');
  return [
    evidence?.packId ?? 'none',
    entry.weekday,
    evidence?.startMinute ?? entry.startMinute,
    evidence?.endMinute ?? entry.endMinute,
    occupantPart,
    entry.status,
    problemPart,
  ].join('|');
}

type RecomputedItem = ReturnType<typeof recomputeEntries>[number];

/** 现场重算行的指纹（与 frozenSignature 同口径） */
function liveSignature(item: RecomputedItem, crossConflicts: string[]): string {
  const occupantPart = item.entry.evidence
    ? item.entry.evidence.occupants
        .map((occupant) => `${occupant.kind}:${occupant.refId}=${occupant.operatorId ?? 'none'}`)
        .sort()
        .join(',')
    : '';
  const problemPart = item.entry.problems
    .filter((problem) => problem.kind !== 'doubleBooked')
    .map((problem) => `${problem.kind}:${problem.text}`)
    .sort()
    .join('||');
  return [
    item.entry.evidence?.packId ?? 'none',
    item.entry.weekday,
    item.entry.startMinute,
    item.entry.endMinute,
    occupantPart,
    item.entry.status === 'conflict' && crossConflicts.length === 0 ? 'ok' : item.entry.status,
    [problemPart, crossConflicts.sort().join('||')].filter(Boolean).join('||'),
  ].join('|');
}

/** 该行在当前重算结果里命中的跨戏撞档指纹（需要全部行一起判） */
function liveCrossConflicts(target: RecomputedItem, all: RecomputedItem[]): string[] {
  const result: string[] = [];
  const targetOperators = new Set(
    (target.entry.evidence?.occupants ?? [])
      .map((occupant) => occupant.operatorId)
      .filter((id): id is string => id !== null),
  );
  all.forEach((other) => {
    if (other.slot.blockId === target.slot.blockId) return;
    const overlap =
      target.slot.startMinute < other.slot.endMinute && other.slot.startMinute < target.slot.endMinute;
    if (!overlap) return;
    const otherOperators = new Set(
      (other.entry.evidence?.occupants ?? [])
        .map((occupant) => occupant.operatorId)
        .filter((id): id is string => id !== null),
    );
    targetOperators.forEach((operatorId) => {
      if (otherOperators.has(operatorId)) result.push(`doubleBooked:${operatorId}:${other.slot.scene.id}`);
    });
  });
  return result;
}

export const useReconStore = create<ReconStoreState>((set, get) => ({
  loading: false,
  error: '',
  plan: null,
  blocks: [],
  entries: [],
  packs: [],
  facts: [],
  plays: [],
  scenes: [],
  roles: [],
  cues: [],
  operators: [],
  draftText: readLocal(STORAGE_KEYS.reconDraft, ''),

  async loadRecon() {
    set({ loading: true, error: '' });
    try {
      const planRow = await ensurePlanRow();
      const [blocks, entries, packs, facts, plays, scenes, roles, cues, operators] = await Promise.all([
        listBlocksByPlan(planRow.id),
        listEntriesByPlan(planRow.id),
        listPacks(),
        listAllFacts(),
        db.plays.toArray(),
        db.scenes.toArray(),
        listAllRoles(),
        db.cues.toArray(),
        listOperators(),
      ]);
      set({
        loading: false,
        plan: planRow,
        blocks,
        entries,
        packs,
        facts,
        plays,
        scenes,
        roles,
        cues,
        operators,
        draftText: readLocal(STORAGE_KEYS.reconDraft, ''),
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '连排对账读取失败' });
    }
  },

  setDraftText(text) {
    set({ draftText: text });
    writeLocal(STORAGE_KEYS.reconDraft, text);
  },

  clearDraft() {
    set({ draftText: '' });
    writeLocal(STORAGE_KEYS.reconDraft, '');
  },

  async setWeekday(weekday) {
    await get().recompute({ planPatch: { weekday } });
  },

  async renamePlan(name) {
    const plan = get().plan;
    if (!plan) return;
    const trimmed = name.trim() || DEFAULT_PLAN_NAME;
    await db.rehearsalPlans.put({ ...plan, name: trimmed, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadRecon();
  },

  async upsertBlock(playId, anchorStartMinute) {
    const plan = get().plan;
    if (!plan) return;
    const stamp = nowIso();
    await db.transaction(
      'rw',
      [
        db.rehearsalPlans,
        db.planBlocks,
        db.reconEntries,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
        db.attendanceFacts,
        db.attendancePacks,
      ],
      async () => {
        const planRow = (await db.rehearsalPlans.get(plan.id)) ?? plan;
        const existing = await db.planBlocks.where('planId').equals(planRow.id).toArray();
        const samePlay = existing.find((block) => block.playId === playId);
        if (samePlay) {
          await db.planBlocks.put({
            ...samePlay,
            anchorStartMinute,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        } else {
          await db.planBlocks.put({
            id: uuid(),
            planId: planRow.id,
            playId,
            anchorStartMinute,
            sortOrder: existing.length,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
        const blocks = (await db.planBlocks.where('planId').equals(planRow.id).toArray()).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        const existingEntries = await db.reconEntries.where('planId').equals(planRow.id).toArray();
        const { next: nextRows, removedUnconfirmed } = await buildNextEntries(planRow, blocks, existingEntries);
        if (removedUnconfirmed.length > 0) {
          await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
        }
        await db.reconEntries.bulkPut(nextRows);
      },
    );
    await get().loadRecon();
  },

  async removeBlock(blockId) {
    const plan = get().plan;
    if (!plan) return;
    await db.transaction(
      'rw',
      [
        db.planBlocks,
        db.reconEntries,
        db.rehearsalPlans,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
        db.attendanceFacts,
        db.attendancePacks,
      ],
      async () => {
        const planRow = (await db.rehearsalPlans.get(plan.id)) ?? plan;
        // 折子移出本计划：该折子下的对账行（含已确认归档行）一并删除
        await db.reconEntries.where('blockId').equals(blockId).delete();
        await db.planBlocks.delete(blockId);
        // 重排剩余折子顺序
        const rest = await db.planBlocks.where('planId').equals(planRow.id).toArray();
        const reordered = rest
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((block, index) =>
            block.sortOrder === index
              ? block
              : { ...block, sortOrder: index, updatedAt: nowIso(), revision: ROW_REVISION },
          );
        await db.planBlocks.bulkPut(reordered);
        // 同一事务内重算其余场次
        const existingEntries = await db.reconEntries.where('planId').equals(planRow.id).toArray();
        const { next: nextRows, removedUnconfirmed } = await buildNextEntries(
          planRow,
          reordered,
          existingEntries,
        );
        if (removedUnconfirmed.length > 0) {
          await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
        }
        await db.reconEntries.bulkPut(nextRows);
      },
    );
    await get().loadRecon();
  },

  async importPack(text, label) {
    // 1. 先在事务外解析：失败直接抛出，旧数据与草稿都不动
    const parsed = parseAttendancePack(text);
    const plan = get().plan ?? (await ensurePlanRow());

    const warnings: string[] = [];
    const operatorNames = new Set((await listOperators()).map((operator) => operator.name));
    parsed.records.forEach((record) => {
      if (!operatorNames.has(record.personName)) {
        warnings.push(`「${record.personName}」不在本地操耍人档，到场记录会保留，但占用核对挂不上人`);
      }
    });

    const stamp = nowIso();
    const packId = uuid();
    const factRows: AttendanceFactRow[] = parsed.records.flatMap((record) =>
      record.windows.map((window) => ({
        id: uuid(),
        packId,
        personName: record.personName,
        weekday: window.weekday,
        startMinute: window.startMinute,
        endMinute: window.endMinute,
        rawText: window.rawText,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })),
    );

    const packRow: AttendancePackRow = {
      id: packId,
      label: (label ?? '').trim() || defaultPackLabel(),
      sourceText: text,
      active: true,
      importedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };

    // 2. 包写入 + 旧包去激活 + 计划换依据 + 未确认行重算，同一个事务（写入不能留半套）
    await db.transaction(
      'rw',
      [
        db.attendancePacks,
        db.attendanceFacts,
        db.rehearsalPlans,
        db.planBlocks,
        db.reconEntries,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
      ],
      async () => {
        await db.attendancePacks.put(packRow);
        await db.attendanceFacts.bulkPut(factRows);

        const planRow = (await db.rehearsalPlans.get(plan.id)) ?? plan;
        const nextPlan: RehearsalPlanRow = {
          ...planRow,
          activePackId: packId,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await db.rehearsalPlans.put(nextPlan);

        const blocks = (await db.planBlocks.where('planId').equals(nextPlan.id).toArray()).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        const existingEntries = await db.reconEntries.where('planId').equals(nextPlan.id).toArray();
        const { next: nextRows, removedUnconfirmed } = await buildNextEntries(nextPlan, blocks, existingEntries);
        if (removedUnconfirmed.length > 0) {
          await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
        }
        await db.reconEntries.bulkPut(nextRows);
      },
    );

    // 事务成功后才清草稿
    get().clearDraft();
    await get().loadRecon();
    return {
      packId,
      personCount: parsed.records.length,
      factCount: factRows.length,
      label: packRow.label,
      warnings,
    };
  },

  async deletePack(packId) {
    const plan = get().plan;
    await db.transaction(
      'rw',
      [
        db.attendancePacks,
        db.attendanceFacts,
        db.rehearsalPlans,
        db.planBlocks,
        db.reconEntries,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
      ],
      async () => {
        await db.attendanceFacts.where('packId').equals(packId).delete();
        await db.attendancePacks.delete(packId);
        if (plan && plan.activePackId === packId) {
          const nextPlan: RehearsalPlanRow = {
            ...plan,
            activePackId: null,
            updatedAt: nowIso(),
            revision: ROW_REVISION,
          };
          await db.rehearsalPlans.put(nextPlan);
          const blocks = await db.planBlocks.where('planId').equals(plan.id).toArray();
          const existingEntries = await db.reconEntries.where('planId').equals(plan.id).toArray();
          const { next: nextRows, removedUnconfirmed } = await buildNextEntries(nextPlan, blocks, existingEntries);
          if (removedUnconfirmed.length > 0) {
            await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
          }
          await db.reconEntries.bulkPut(nextRows);
        }
      },
    );
    await get().loadRecon();
  },

  async activatePack(packId) {
    const plan = get().plan;
    if (!plan) return;
    await db.transaction(
      'rw',
      [
        db.attendancePacks,
        db.rehearsalPlans,
        db.planBlocks,
        db.reconEntries,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
        db.attendanceFacts,
      ],
      async () => {
        await db.attendancePacks.toCollection().modify((row: AttendancePackRow) => {
          row.active = row.id === packId;
        });
        const nextPlan: RehearsalPlanRow = {
          ...plan,
          activePackId: packId,
          updatedAt: nowIso(),
          revision: ROW_REVISION,
        };
        await db.rehearsalPlans.put(nextPlan);
        const blocks = await db.planBlocks.where('planId').equals(plan.id).toArray();
        const existingEntries = await db.reconEntries.where('planId').equals(plan.id).toArray();
        const { next: nextRows, removedUnconfirmed } = await buildNextEntries(nextPlan, blocks, existingEntries);
        if (removedUnconfirmed.length > 0) {
          await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
        }
        await db.reconEntries.bulkPut(nextRows);
      },
    );
    await get().loadRecon();
  },

  async confirmEntry(entryId) {
    const plan = get().plan;
    if (!plan) return;
    const existing = await db.reconEntries.get(entryId);
    if (!existing) return;
    const stamp = nowIso();
    await db.reconEntries.put({
      ...existing,
      confirmed: true,
      dirty: false,
      confirmedAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadRecon();
  },

  async unconfirmEntry(entryId) {
    // 解冻与按当前依据重算放进同一个事务：先在事务内解冻，再整体重算
    await get().recompute({ unconfirmEntryIds: [entryId] });
  },

  async recompute(options) {
    const plan = get().plan;
    if (!plan && !options?.planPatch) {
      await get().loadRecon();
      return;
    }
    const basePlan = plan ?? (await ensurePlanRow());
    const unconfirmIds = new Set(options?.unconfirmEntryIds ?? []);
    await db.transaction(
      'rw',
      [
        db.rehearsalPlans,
        db.planBlocks,
        db.reconEntries,
        db.scenes,
        db.roles,
        db.cues,
        db.operators,
        db.attendanceFacts,
        db.attendancePacks,
      ],
      async () => {
        const storedPlan = (await db.rehearsalPlans.get(basePlan.id)) ?? basePlan;
        const planRow: RehearsalPlanRow = options?.planPatch
          ? { ...storedPlan, ...options.planPatch, updatedAt: nowIso(), revision: ROW_REVISION }
          : storedPlan;
        if (options?.planPatch) await db.rehearsalPlans.put(planRow);
        const blocks = (await db.planBlocks.where('planId').equals(planRow.id).toArray()).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        const existingEntries = await db.reconEntries.where('planId').equals(planRow.id).toArray();
        const { next: nextRows, removedUnconfirmed } = await buildNextEntries(
          planRow,
          blocks,
          existingEntries,
          unconfirmIds,
        );
        if (removedUnconfirmed.length > 0) {
          await db.reconEntries.bulkDelete(removedUnconfirmed.map((entry) => entry.id));
        }
        await db.reconEntries.bulkPut(nextRows);
      },
    );
    await get().loadRecon();
  },
}));

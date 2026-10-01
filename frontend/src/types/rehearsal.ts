/**
 * 连排对账（Rehearsal Reconciliation）数据模型
 *
 * 面向「巡演周一跨剧目连排」：外班日程包只提供到场事实（姓名 + 可到场时段），
 * 本地场序与时长决定每场起止；角色操耍人与锣鼓点领奏都算占用。
 *
 * 对账口径：
 * - 包只负责「某人某星期某时段能到场」；
 * - 每出戏的锚点时刻 + 本地场序/时长推出每场起止；
 * - 已确认场次冻结旧依据；包更新后未确认场次失效重算，已确认场次保留旧依据。
 */
import type { Weekday } from './operator';

/** 对账结论：可对上 / 待补（缺信息，不能按空闲处理）/ 冲突 */
export type ReconEntryStatus = 'ok' | 'needInfo' | 'conflict';

/** 占用来源：角色操耍人 / 锣鼓点领奏 */
export type OccupantKind = 'role' | 'cue';

/** 场次的一项人员占用（角色或领奏，指向某位操耍人） */
export interface OccupantRef {
  kind: OccupantKind;
  /** 角色 id 或锣鼓点 id */
  refId: string;
  /** 占用标签，如「角色·白娘子」「领奏·急急风 00:08」 */
  label: string;
  /** 操耍人 id；未指派为 null（对账时按待补处理） */
  operatorId: string | null;
  /** 冻结的操耍人姓名，用于展示与按人对账；未指派为「待指派」 */
  operatorName: string;
}

/** 到场窗口（日程包解析出的事实片段） */
export interface AttendanceWindow {
  weekday: Weekday;
  /** 起始分钟偏移（相对当日 08:00，可负，表示早于 8 点） */
  startMinute: number;
  /** 结束分钟偏移 */
  endMinute: number;
  /** 原始文本片段，便于在依据里回看 */
  rawText: string;
}

/** 外班日程包：一次粘贴导入的原文与元信息 */
export interface AttendancePack {
  id: string;
  /** 包名，默认「外班日程包 MM-DD HH:mm」 */
  label: string;
  /** 粘贴导入的原文（草稿失败时不动它，导入成功后留档） */
  sourceText: string;
  /** 是否为当前对账依据包（最新一次导入自动激活） */
  active: boolean;
  /** 导入时间（ISO） */
  importedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 到场事实行：姓名 × 单个到场窗口 */
export interface AttendanceFact {
  id: string;
  /** 所属日程包 id */
  packId: string;
  /** 外班提供的姓名（与本地操耍人档按姓名精确对上） */
  personName: string;
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
  /** 原始时段文本 */
  rawText: string;
  createdAt: string;
  updatedAt: string;
}

/** 连排计划：一次跨剧目连排（巡演场景下默认周一） */
export interface RehearsalPlan {
  id: string;
  /** 计划名称 */
  name: string;
  /** 连排日，默认周一 = 1 */
  weekday: Weekday;
  /** 当前依据的日程包 id；尚未导入为 null（所有占用一律待补） */
  activePackId: string | null;
  /** 保留单例计划的标记位与索引字段 */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 计划里的一折戏：本计划内该剧目从当日哪个锚点开排 */
export interface PlanBlock {
  id: string;
  planId: string;
  playId: string;
  /** 锚点开场分钟偏移（相对当日 08:00），本地场序与时长决定之后每场起止 */
  anchorStartMinute: number;
  /** 折子在本计划内的排列顺序 */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 对账问题类型 */
export type ReconProblemKind =
  /** 占用（角色 / 领奏）尚未指派操耍人 */
  | 'unassigned'
  /** 日程包里没有该姓名的到场记录（老剧目缺记录：标待补，绝不能当空闲） */
  | 'missingRecord'
  /** 有到场记录，但窗口不能完整覆盖本场起止 */
  | 'coverageGap'
  /** 同一操耍人在同一时刻被排到两出戏 */
  | 'doubleBooked';

/** 单场对账问题 */
export interface ReconProblem {
  kind: ReconProblemKind;
  text: string;
  /** 冲突对端场次 id（doubleBooked 时有值） */
  otherSceneId?: string;
  /** 冲突对端场次标题 */
  otherSceneTitle?: string;
}

/** 某位操耍人命中的到场窗口（冻结在依据里） */
export interface EvidenceWindowGroup {
  operatorId: string;
  operatorName: string;
  windows: AttendanceWindow[];
}

/**
 * 场次对账依据：算结论时使用的那一版事实快照。
 * 已确认场次在包更新后仍保留旧依据（旧包 id + 旧窗口）。
 */
export interface ReconEvidence {
  /** 依据包 id；无包时为 null */
  packId: string | null;
  /** 依据包名（旧包删除后仍能展示） */
  packLabel: string;
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
  occupants: OccupantRef[];
  /** 每位操耍人在依据包内的全部到场窗口 */
  windowsByOperator: EvidenceWindowGroup[];
  /** 计算时间（ISO） */
  computedAt: string;
}

/** 场次对账行：计划内一个本地场次的对账结论与确认状态 */
export interface ReconEntry {
  id: string;
  planId: string;
  blockId: string;
  sceneId: string;
  weekday: Weekday;
  /** 本场起（分钟偏移，由锚点 + 前序场时长推出） */
  startMinute: number;
  /** 本场止 */
  endMinute: number;
  status: ReconEntryStatus;
  problems: ReconProblem[];
  /** 是否已确认；已确认行的结论与依据冻结 */
  confirmed: boolean;
  /** 未确认行依赖过期时置位，下次重算清除 */
  dirty: boolean;
  confirmedAt: string | null;
  /** 冻结依据；新建未算时为 null */
  evidence: ReconEvidence | null;
  createdAt: string;
  updatedAt: string;
}

export const RECON_STATUS_META: Record<
  ReconEntryStatus,
  { label: string; color: string }
> = {
  ok: { label: '可对上', color: 'success' },
  needInfo: { label: '待补', color: 'warning' },
  conflict: { label: '冲突', color: 'error' },
};

export const RECON_PROBLEM_KIND_LABEL: Record<ReconProblemKind, string> = {
  unassigned: '未指派',
  missingRecord: '缺到场记录',
  coverageGap: '到场不覆盖',
  doubleBooked: '两戏撞档',
};

/** 连排默认排练日：周一（巡演日） */
export const DEFAULT_RECON_WEEKDAY: Weekday = 1;

/** 新建折子的默认锚点：08:00 整（分钟偏移 0） */
export const DEFAULT_BLOCK_ANCHOR_MINUTE = 0;

/** 计划名 */
export const DEFAULT_PLAN_NAME = '巡演周一连排';

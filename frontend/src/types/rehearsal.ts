/**
 * 连排对账数据模型
 * 外班「日程包」只提供到场事实（谁、星期几、几点到几点）；
 * 本地场序与场次时长决定每场起止，角色操耍人与锣鼓点领奏都算占用。
 */
import type { Weekday } from './operator';
import { DAY_BASE_HOUR } from './operator';

/** 一条到场事实：某人某排练日可到场的时段（绝对时钟） */
export interface AvailabilityEntry {
  /** 姓名（与本地操耍人姓名对齐） */
  name: string;
  /** 星期，0 = 周日 */
  weekday: Weekday;
  /** 到场开始：相对当日 08:00 的分钟偏移（与 BusySlot 同基准） */
  startMinute: number;
  /** 到场结束：相对当日 08:00 的分钟偏移 */
  endMinute: number;
}

/**
 * 外班日程包
 * 每次成功导入生成一个新版本；当前只以最新包为到场依据，旧包留存可查。
 */
export interface AvailabilityPackage {
  /** 主键，uuid */
  id: string;
  /** 导入时粘入的原始文本 */
  rawText: string;
  /** 解析后的到场事实 */
  entries: AvailabilityEntry[];
  /** 覆盖到的姓名（去重） */
  names: string[];
  /** 覆盖到的排练日 */
  weekdays: Weekday[];
  /** 导入时无法解析的行（用于对账页提示，不阻塞合法行入库） */
  warnings: string[];
  /** 是否为当前生效的包（同一时刻至多一个） */
  active: boolean;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
}

/** 连排场次状态 */
export type JointSessionStatus =
  | 'unconfirmed' // 已排入时间轴，等待师傅确认
  | 'confirmed' // 师傅已确认；包更新后保留旧依据
  | 'pending' // 缺到场记录，待补，绝不能当作空闲
  | 'blocked'; // 到场窗口装不下 / 冲突，无法落位

/** 占用一条场次的人员来源 */
export type OccupationKind = 'role' | 'lead';

/** 场次占用人员（角色操耍人 + 锣鼓点领奏，同人去重） */
export interface OccupiedPerson {
  operatorId: string | null;
  /** 姓名：operatorId 为空时为「待指派」占位 */
  name: string;
  /** 占用来源（同一人可能既操耍角色又领奏） */
  kinds: OccupationKind[];
  /** 关联说明，如「白娘子」「开场四击头领奏」 */
  refs: string[];
}

/**
 * 连排场次（跨剧目）
 * 一场本地 Scene 在某次对账中落位的结果。
 */
export interface JointSession {
  /** 主键，uuid */
  id: string;
  /** 依据的日程包 id */
  packageId: string;
  /** 本地场次 id */
  sceneId: string;
  /** 冗余剧目 id / 剧目名 / 场序 / 场次标题，旧场次删除后仍可读 */
  playId: string;
  playTitle: string;
  seq: number;
  sceneTitle: string;
  /** 时长（分钟，落位时快照） */
  durationMin: number;
  /** 落位排练日；待补/受阻可能给不出 */
  weekday: Weekday | null;
  /** 起止（相对 08:00 的分钟偏移） */
  startMinute: number | null;
  endMinute: number | null;
  status: JointSessionStatus;
  /** 占用人员（落位时快照） */
  occupied: OccupiedPerson[];
  /** 未能排入/待补的原因 */
  reason: string;
  /** 推算该场用到的到场窗口（落位时快照，便于事后核对） */
  basisWindows: Array<{ name: string; weekday: Weekday; startMinute: number; endMinute: number }>;
  /**
   * 本地依据签名：场序、时长、角色操耍人、领奏的规范化摘要。
   * 本地数据变化后签名不同 → 未确认场次失效重算，已确认场次留下旧依据。
   */
  basisSignature: string;
  /** 落位时的本地依据快照（人类可读，已确认场次据此展示「旧依据」） */
  basisSnapshot: string;
  createdAt: string;
  updatedAt: string;
}

export const JOINT_STATUS_LABEL: Record<JointSessionStatus, string> = {
  unconfirmed: '待确认',
  confirmed: '已确认',
  pending: '待补到场',
  blocked: '排不进',
};

export const JOINT_STATUS_COLOR: Record<JointSessionStatus, string> = {
  unconfirmed: 'gold',
  confirmed: 'green',
  pending: 'orange',
  blocked: 'red',
};

export const OCCUPATION_KIND_LABEL: Record<OccupationKind, string> = {
  role: '角色',
  lead: '领奏',
};

/** HH:mm → 相对 08:00 的分钟偏移；非法返回 null */
export function clockToMinute(clock: string): number | null {
  const matched = /^(\d{1,2}):([0-5]?\d)$/.exec(clock.trim());
  if (!matched) return null;
  const hour = Number.parseInt(matched[1], 10);
  const minute = Number.parseInt(matched[2], 10);
  if (hour < DAY_BASE_HOUR || hour > 22) return null;
  return hour * 60 + minute - DAY_BASE_HOUR * 60;
}

/** 相对 08:00 的分钟偏移 → HH:mm */
export function minuteToClockLocal(minute: number): string {
  const total = DAY_BASE_HOUR * 60 + minute;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 连排对账状态管理（Zustand）
 * 持有当前生效日程包与全部连排场次，封装：
 * - 导入（解析失败不写库；写库走单事务，不留半套）
 * - 重算（包更新/本地依据变化后，非确认场次失效重算，已确认场次留旧依据）
 * - 确认 / 撤销确认
 * 本地场序、时长、角色操耍人、锣鼓点领奏由各页面自行落库后调用 invalidate/recompute。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  commitPackageImport,
  commitRecompute,
  confirmJointSession,
  db,
  getActivePackage,
  listAvailabilityPackages,
  listJointSessions,
  listPlays,
  putJointSession,
  type AvailabilityPackageRow,
  type JointSessionRow,
} from '../utils/db';
import { parseScheduleText, buildPackageDraft, newPackageId, packageStamp } from '../utils/scheduleParser';
import {
  buildBasisSignature,
  planRehearsal,
  toSessionRows,
  type LocalBasis,
} from '../utils/rehearsalPlanner';
import { nowIso } from '../utils/uuid';

export interface ImportOutcome {
  ok: boolean;
  /** 导入失败原因（ok=false 时有值；草稿由页面保留，可改后重试） */
  error?: string;
  warnings: string[];
  entryCount: number;
}

interface RehearsalStoreState {
  activePackage: AvailabilityPackageRow | null;
  packages: AvailabilityPackageRow[];
  sessions: JointSessionRow[];
  local: LocalBasis | null;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 解析并导入一段日程包文本；失败时不触碰库内数据 */
  importPackage: (rawText: string) => Promise<ImportOutcome>;
  /** 依据当前包重算指定剧目（playIds 为空则全部）；已确认场次保留旧依据 */
  recompute: (playIds?: string[]) => Promise<void>;
  /** 检查非确认场次的本地依据是否过期，过期即自动重算 */
  refreshStale: () => Promise<boolean>;
  confirmSession: (sessionId: string) => Promise<void>;
  unconfirmSession: (sessionId: string) => Promise<void>;
  /** 当前本地依据下，某场连排的依据签名是否过期 */
  isStale: (session: JointSessionRow) => boolean;
}

async function fetchLocalBasis(): Promise<LocalBasis> {
  const [plays, scenes, roles, cues, operators] = await Promise.all([
    listPlays(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.cues.toArray(),
    db.operators.toArray(),
  ]);
  return { plays, scenes, roles, cues, operators };
}

export const useRehearsalStore = create<RehearsalStoreState>((set, get) => ({
  activePackage: null,
  packages: [],
  sessions: [],
  local: null,
  loading: false,
  error: '',

  async load() {
    set({ loading: true, error: '' });
    try {
      const [activePackage, packages, sessions, local] = await Promise.all([
        getActivePackage(),
        listAvailabilityPackages(),
        listJointSessions(),
        fetchLocalBasis(),
      ]);
      set({
        activePackage: activePackage ?? null,
        packages,
        sessions,
        local,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '连排对账数据读取失败' });
    }
  },

  async importPackage(rawText) {
    const trimmed = rawText.trim();
    if (trimmed === '') {
      return { ok: false, error: '日程包为空：请把外班交来的到场时段文本粘进来', warnings: [], entryCount: 0 };
    }
    const parsed = parseScheduleText(trimmed);
    if (parsed.entries.length === 0) {
      return {
        ok: false,
        error:
          parsed.warnings.length > 0
            ? `一条到场记录都没认出来：${parsed.warnings[0].reason}`
            : '未识别出任何到场记录，请检查格式（姓名、周一～周日、HH:mm-HH:mm）',
        warnings: parsed.warnings.map((item) => `第 ${item.line} 行：${item.reason}`),
        entryCount: 0,
      };
    }

    const draft = buildPackageDraft(trimmed, parsed);
    const pkgRow: AvailabilityPackageRow = {
      ...draft,
      id: newPackageId(),
      active: true,
      createdAt: packageStamp(),
      revision: ROW_REVISION,
    };

    // 先在事务外做推算（纯计算），保证事务里只做写入
    const local = (get().local ?? (await fetchLocalBasis())) as LocalBasis;
    const planned = planRehearsal(pkgRow, local);
    const newSessions = toSessionRows(planned, pkgRow.id);

    // 单事务落库：旧包转历史、旧推算场次作废、新包与新场次整体写入；失败整体回滚
    const previousPackageId = get().activePackage?.id ?? null;
    await commitPackageImport(pkgRow, previousPackageId, newSessions);
    await get().load();

    return {
      ok: true,
      warnings: draft.warnings,
      entryCount: parsed.entries.length,
    };
  },

  async recompute(playIds = []) {
    const { activePackage } = get();
    if (!activePackage) return;
    const local = await fetchLocalBasis();
    const planned = planRehearsal(activePackage, local, playIds.length > 0 ? playIds : undefined);
    const rows = toSessionRows(planned, activePackage.id);
    await commitRecompute(activePackage.id, playIds, rows);
    set({ local });
    const sessions = await listJointSessions();
    set({ sessions });
  },

  isStale(session) {
    const { local } = get();
    if (!local) return false;
    if (session.status === 'confirmed') return false;
    return session.basisSignature !== buildBasisSignature(local, session.playId);
  },

  async refreshStale() {
    const { sessions, activePackage } = get();
    if (!activePackage) return false;
    const local = await fetchLocalBasis();
    set({ local });
    const stalePlayIds = [
      ...new Set(
        sessions
          .filter((row) => row.status !== 'confirmed')
          .filter((row) => row.basisSignature !== buildBasisSignature(local, row.playId))
          .map((row) => row.playId),
      ),
    ];
    if (stalePlayIds.length === 0) return false;
    await get().recompute(stalePlayIds);
    return true;
  },

  async confirmSession(sessionId) {
    await confirmJointSession(sessionId);
    const sessions = await listJointSessions();
    set({ sessions });
  },

  async unconfirmSession(sessionId) {
    // 撤销确认后，该场回到待确认；随后依据当前数据走一次重算，避免拿着旧依据
    const row = get().sessions.find((item) => item.id === sessionId);
    if (!row) return;
    await putJointSession({ ...row, status: 'unconfirmed', updatedAt: nowIso(), revision: ROW_REVISION });
    await get().recompute([row.playId]);
  },
}));

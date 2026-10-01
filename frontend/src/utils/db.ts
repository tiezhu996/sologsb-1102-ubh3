/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type { AvailabilityPackage, JointSession } from '../types/rehearsal';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据库名 */
export const DB_NAME = 'gbshadowplay';

/** 带结构修订号的持久化实体 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

export type PlayRow = Play & Revisioned;
export type SceneRow = Scene & Revisioned;
export type RoleRow = ShadowRole & Revisioned;
export type OperatorRow = Operator & Revisioned;
export type CueRow = PercussionCue & Revisioned;
export type AvailabilityPackageRow = AvailabilityPackage & Revisioned;
export type JointSessionRow = JointSession & Revisioned;

export const ROW_REVISION = 2;

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  availabilityPackages!: Table<AvailabilityPackageRow, string>;
  jointSessions!: Table<JointSessionRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅基础自增字段，保留历史数据）
    this.version(1).stores({
      plays: 'id, title, genre, status, createdAt',
      scenes: 'id, playId, seq, progress',
      roles: 'id, sceneId, operatorId, roleType',
      operators: 'id, name',
      cues: 'id, sceneId, atSecond, instrument',
    });

    // v2：新增 revision 行修订号；场次补充索引，锣鼓点补充 playId 冗余便于按剧目统计
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
      })
      .upgrade(async (tx) => {
        // 迁移：补齐 revision，并兜底历史数据里缺失的字段
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('plays'),
          tx.table('scenes'),
          tx.table('roles'),
          tx.table('operators'),
          tx.table('cues'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
      });

    // v3：新增「连排对账」——外班日程包（到场事实）与跨剧目连排场次
    this.version(DB_SCHEMA_VERSION).stores({
      availabilityPackages: 'id, createdAt',
      jointSessions: 'id, packageId, sceneId, playId, status, weekday',
    });
  }
}

export const db = new ShadowPlayDatabase();

/** 打开数据库：首次使用时灌入示例班社数据，保证界面不为空壳 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.plays.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 剧目 ------------------------------ */

export async function listPlays(): Promise<PlayRow[]> {
  return db.plays.orderBy('createdAt').reverse().toArray();
}

export async function getPlay(id: string): Promise<PlayRow | undefined> {
  return db.plays.get(id);
}

export async function putPlay(row: PlayRow): Promise<void> {
  await db.plays.put(row);
}

export async function removePlay(id: string): Promise<void> {
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
    await db.plays.delete(id);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenesByPlay(playId: string): Promise<SceneRow[]> {
  const rows = await db.scenes.where('playId').equals(playId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getScene(id: string): Promise<SceneRow | undefined> {
  return db.scenes.get(id);
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(row);
}

export async function putScenes(rows: SceneRow[]): Promise<void> {
  await db.scenes.bulkPut(rows);
}

export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', db.scenes, db.roles, db.cues, async () => {
    await db.roles.where('sceneId').equals(id).delete();
    await db.cues.where('sceneId').equals(id).delete();
    await db.scenes.delete(id);
  });
}

/* ---------------------------- 影人角色 ---------------------------- */

export async function listRolesByScene(sceneId: string): Promise<RoleRow[]> {
  return db.roles.where('sceneId').equals(sceneId).toArray();
}

export async function listRolesByScenes(sceneIds: string[]): Promise<RoleRow[]> {
  if (sceneIds.length === 0) return [];
  return db.roles.where('sceneId').anyOf(sceneIds).toArray();
}

export async function listAllRoles(): Promise<RoleRow[]> {
  return db.roles.toArray();
}

export async function putRole(row: RoleRow): Promise<void> {
  await db.roles.put(row);
}

export async function removeRole(id: string): Promise<void> {
  await db.roles.delete(id);
}

/* ----------------------------- 操耍人 ----------------------------- */

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await db.operators.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getOperator(id: string): Promise<OperatorRow | undefined> {
  return db.operators.get(id);
}

export async function putOperator(row: OperatorRow): Promise<void> {
  await db.operators.put(row);
}

export async function putOperators(rows: OperatorRow[]): Promise<void> {
  await db.operators.bulkPut(rows);
}

export async function removeOperator(id: string): Promise<void> {
  await db.transaction('rw', db.operators, db.roles, async () => {
    const bound = await db.roles.where('operatorId').equals(id).toArray();
    if (bound.length > 0) {
      await db.roles.bulkPut(bound.map((role) => ({ ...role, operatorId: null, updatedAt: nowIso() })));
    }
    await db.cues.where('leadOperator').equals(id).modify({ leadOperator: null });
    await db.operators.delete(id);
  });
}

/* ----------------------------- 锣鼓点 ----------------------------- */

export async function listCuesByScene(sceneId: string): Promise<CueRow[]> {
  const rows = await db.cues.where('sceneId').equals(sceneId).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function putCue(row: CueRow): Promise<void> {
  await db.cues.put(row);
}

export async function removeCue(id: string): Promise<void> {
  await db.cues.delete(id);
}

/* --------------------------- 连排对账 --------------------------- */

export async function listAvailabilityPackages(): Promise<AvailabilityPackageRow[]> {
  const rows = await db.availabilityPackages.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getActivePackage(): Promise<AvailabilityPackageRow | undefined> {
  // active 为布尔，IndexedDB 无法以布尔作键，故不建索引，直接扫描最新生效包
  const rows = await db.availabilityPackages.toArray();
  return rows.find((row) => row.active) ?? rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function listJointSessions(): Promise<JointSessionRow[]> {
  return db.jointSessions.toArray();
}

export async function listJointSessionsByPackage(packageId: string): Promise<JointSessionRow[]> {
  return db.jointSessions.where('packageId').equals(packageId).toArray();
}

export async function putJointSession(row: JointSessionRow): Promise<void> {
  await db.jointSessions.put(row);
}

export async function putJointSessions(rows: JointSessionRow[]): Promise<void> {
  await db.jointSessions.bulkPut(rows);
}

/**
 * 原子写入新日程包并重算未确认场次：
 * 单事务完成「旧包转 inactive → 新包 active → 作废旧包的未确认/待补/受阻场次并替换」。
 * 已确认场次一律原样保留（带着旧 packageId 与旧依据）；其他历史包的未确认场次留作旧依据快照。
 * 写入失败整体回滚，不留半套。
 */
export async function commitPackageImport(
  pkgRow: AvailabilityPackageRow,
  previousPackageId: string | null,
  newSessions: JointSessionRow[],
): Promise<void> {
  await db.transaction(
    'rw',
    db.availabilityPackages,
    db.jointSessions,
    async () => {
      await db.availabilityPackages.toCollection().modify({ active: false });
      await db.availabilityPackages.put(pkgRow);
      if (previousPackageId) {
        const old = await db.jointSessions.where('packageId').equals(previousPackageId).toArray();
        const staleIds = old
          .filter((row) => row.status !== 'confirmed')
          .map((row) => row.id);
        if (staleIds.length > 0) await db.jointSessions.bulkDelete(staleIds);
      }
      if (newSessions.length > 0) await db.jointSessions.bulkPut(newSessions);
    },
  );
}

/**
 * 原子重算：替换指定剧目下、指定包内的非确认场次；已确认场次不动。
 * 本地场序/时长/指派变化导致依据签名过期时调用。
 */
export async function commitRecompute(
  packageId: string,
  playIds: string[],
  newSessions: JointSessionRow[],
): Promise<void> {
  await db.transaction('rw', db.jointSessions, async () => {
    const existing = await db.jointSessions.where('packageId').equals(packageId).toArray();
    const staleIds = existing
      .filter((row) => row.status !== 'confirmed' && (playIds.length === 0 || playIds.includes(row.playId)))
      .map((row) => row.id);
    if (staleIds.length > 0) await db.jointSessions.bulkDelete(staleIds);
    if (newSessions.length > 0) await db.jointSessions.bulkPut(newSessions);
  });
}

/** 确认单场（同事务更新） */
export async function confirmJointSession(sessionId: string): Promise<void> {
  const row = await db.jointSessions.get(sessionId);
  if (!row) return;
  await db.jointSessions.put({ ...row, status: 'confirmed', updatedAt: nowIso(), revision: ROW_REVISION });
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  /** 快照标识，固定为数据库名 */
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plays: Play[];
  scenes: Scene[];
  roles: ShadowRole[];
  operators: Operator[];
  cues: PercussionCue[];
  availabilityPackages: AvailabilityPackage[];
  jointSessions: JointSession[];
}

/** 导出整库快照（去掉内部 revision 字段） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plays, scenes, roles, operators, cues, availabilityPackages, jointSessions] = await Promise.all([
    db.plays.toArray(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.operators.toArray(),
    db.cues.toArray(),
    db.availabilityPackages.toArray(),
    db.jointSessions.toArray(),
  ]);
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row;
    return rest;
  };
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plays: plays.map(strip),
    scenes: scenes.map(strip),
    roles: roles.map(strip),
    operators: operators.map(strip),
    cues: cues.map(strip),
    availabilityPackages: availabilityPackages.map(strip),
    jointSessions: jointSessions.map(strip),
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const tables = [
    db.plays,
    db.scenes,
    db.roles,
    db.operators,
    db.cues,
    db.availabilityPackages,
    db.jointSessions,
  ] as const;
  await db.transaction('rw', [...tables], async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
      db.availabilityPackages.clear(),
      db.jointSessions.clear(),
    ]);
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION });
    await db.plays.bulkPut(snapshot.plays.map(rev));
    await db.scenes.bulkPut(snapshot.scenes.map(rev));
    await db.roles.bulkPut(snapshot.roles.map(rev));
    await db.operators.bulkPut(snapshot.operators.map(rev));
    await db.cues.bulkPut(snapshot.cues.map(rev));
    await db.availabilityPackages.bulkPut((snapshot.availabilityPackages ?? []).map(rev));
    await db.jointSessions.bulkPut((snapshot.jointSessions ?? []).map(rev));
  });
}

/** 清空全部数据并重新灌入示例数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.operators, db.cues, db.availabilityPackages, db.jointSessions],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.operators.clear(),
        db.cues.clear(),
        db.availabilityPackages.clear(),
        db.jointSessions.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 粗略统计各表行数，用于页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [plays, scenes, roles, operators, cues, packages, jointSessions] = await Promise.all([
    db.plays.count(),
    db.scenes.count(),
    db.roles.count(),
    db.operators.count(),
    db.cues.count(),
    db.availabilityPackages.count(),
    db.jointSessions.count(),
  ]);
  return { plays, scenes, roles, operators, cues, availabilityPackages: packages, jointSessions };
}

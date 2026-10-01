/**
 * 连排场次冲突检测
 * 已确认场次依据旧包/旧依据保留，不参与新一轮推算的避让，
 * 因此落完盘后再对「全部已落位场次（含已确认）」做一次两两扫描：
 * 同一操耍人在同一排练日、时刻重叠，即「师傅同时被排到两出戏」。
 */
import type { JointSessionRow } from '../utils/db';
import { slotsOverlap, type SlotRange, type Weekday } from '../types/operator';

export interface SessionConflict {
  sessionId: string;
  otherSessionId: string;
  operatorId: string;
  operatorName: string;
  weekday: Weekday;
  /** 重叠区间 */
  overlapStart: number;
  overlapEnd: number;
  describe: string;
}

function rangesOfSession(session: JointSessionRow): Array<{ operatorId: string; name: string; range: SlotRange }> {
  if (session.weekday === null || session.startMinute === null || session.endMinute === null) return [];
  return session.occupied
    .filter((person) => person.operatorId !== null)
    .map((person) => ({
      operatorId: person.operatorId as string,
      name: person.name,
      range: {
        slotId: session.id,
        weekday: session.weekday as Weekday,
        startMinute: session.startMinute as number,
        endMinute: session.endMinute as number,
        label: `${session.playTitle}·${session.sceneTitle}`,
      },
    }));
}

/** 扫描全部已落位连排场次，返回每个场次涉及的冲突 */
export function detectSessionConflicts(sessions: JointSessionRow[]): Map<string, SessionConflict[]> {
  const placed = sessions.filter(
    (session) => session.weekday !== null && session.startMinute !== null && session.endMinute !== null,
  );
  const result = new Map<string, SessionConflict[]>();

  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const left = rangesOfSession(placed[i]);
      const right = rangesOfSession(placed[j]);
      left.forEach((a) => {
        right.forEach((b) => {
          if (a.operatorId !== b.operatorId) return;
          if (!slotsOverlap(a.range, b.range)) return;
          const weekday = a.range.weekday;
          const overlapStart = Math.max(a.range.startMinute, b.range.startMinute);
          const overlapEnd = Math.min(a.range.endMinute, b.range.endMinute);
          const describe = `${a.name} 在${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday]} 同时被排在《${
            placed[i].playTitle
          }·${placed[i].sceneTitle}》与《${placed[j].playTitle}·${placed[j].sceneTitle}》`;
          const conflict: SessionConflict = {
            sessionId: placed[i].id,
            otherSessionId: placed[j].id,
            operatorId: a.operatorId,
            operatorName: a.name,
            weekday,
            overlapStart,
            overlapEnd,
            describe,
          };
          const push = (key: string, value: SessionConflict): void => {
            const list = result.get(key) ?? [];
            list.push(value);
            result.set(key, list);
          };
          push(placed[i].id, conflict);
          push(placed[j].id, { ...conflict, sessionId: placed[j].id, otherSessionId: placed[i].id });
        });
      });
    }
  }
  return result;
}

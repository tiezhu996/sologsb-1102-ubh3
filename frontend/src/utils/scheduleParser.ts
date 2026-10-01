/**
 * 外班日程包文本解析
 * 外班交来的日程包只有「姓名 + 可到场时段」，格式不统一，这里做容错解析：
 * 每行独立解析，识别排练日、一个或多个时段，剩余中文片段视为姓名。
 * 解析失败的行收进 warnings，不阻塞同行/其他行的合法数据；整包没有任何合法行才算导入失败。
 */
import type { AvailabilityEntry, AvailabilityPackage } from '../types/rehearsal';
import { clockToMinute } from '../types/rehearsal';
import type { Weekday } from '../types/operator';
import { nowIso, uuid } from './uuid';

/** 排练日写法 → 星期数字（0 = 周日） */
const WEEKDAY_WORDS: Array<{ re: RegExp; value: Weekday }> = [
  { re: /(?:周|星期|礼拜)\s*日|(?:周|星期|礼拜)\s*天/, value: 0 },
  { re: /(?:周|星期|礼拜)\s*一/, value: 1 },
  { re: /(?:周|星期|礼拜)\s*二/, value: 2 },
  { re: /(?:周|星期|礼拜)\s*三/, value: 3 },
  { re: /(?:周|星期|礼拜)\s*四/, value: 4 },
  { re: /(?:周|星期|礼拜)\s*五/, value: 5 },
  { re: /(?:周|星期|礼拜)\s*六/, value: 6 },
];

/** 单个时钟写法：8:00 / 8：00 / 8点 / 8点半 */
const CLOCK_PART = '(\\d{1,2})\\s*(?:[:：]|点)\\s*(\\d{1,2}|半)?';
/** 一对起止时钟，分隔符允许 - ~ — – 至 到 */
const RANGE_RE = new RegExp(`${CLOCK_PART}\\s*[-~—–至到]+\\s*${CLOCK_PART}`, 'g');

function parseClock(rawHour: string, rawMinute: string | undefined): number | null {
  const minuteText = rawMinute === undefined ? '' : rawMinute.trim();
  if (minuteText === '半') {
    return clockToMinute(`${rawHour}:30`);
  }
  const mm = minuteText === '' ? '00' : minuteText.padStart(2, '0');
  return clockToMinute(`${rawHour}:${mm}`);
}

export interface ParsePackageResult {
  entries: AvailabilityEntry[];
  /** 行号（1 起）→ 问题说明 */
  warnings: Array<{ line: number; text: string; reason: string }>;
}

/** 解析一整段日程包文本 */
export function parseScheduleText(text: string): ParsePackageResult {
  const entries: AvailabilityEntry[] = [];
  const warnings: ParsePackageResult['warnings'] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    const lineNo = index + 1;

    // 1) 排练日
    let weekday: Weekday | null = null;
    for (const item of WEEKDAY_WORDS) {
      if (item.re.test(line)) {
        weekday = item.value;
        break;
      }
    }

    // 2) 时段（一行可能写多个窗口）
    const ranges: Array<{ start: number; end: number }> = [];
    const strippedRanges = line.replace(RANGE_RE, (_match, h1: string, m1: string | undefined, h2: string, m2: string | undefined) => {
      const start = parseClock(h1, m1);
      const end = parseClock(h2, m2);
      if (start !== null && end !== null && end > start) {
        ranges.push({ start, end });
      }
      return ' ';
    });

    // 3) 姓名：剥掉排练日词、空白与标点后，剩下的中文片段都算姓名候选
    let residue = strippedRanges;
    for (const item of WEEKDAY_WORDS) {
      residue = residue.replace(item.re, ' ');
    }
    const nameParts = residue
      .split(/[\s、,，。.;；/／|]+/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    // 只保留含中日韩字符或拉丁字母的片段，剔除纯标点/数字残留
    const names = nameParts.filter((part) => /[㐀-鿿豈-﫿A-Za-z]/.test(part));

    if (weekday === null) {
      warnings.push({ line: lineNo, text: rawLine, reason: '没认出排练日（周一～周日）' });
      return;
    }
    if (ranges.length === 0) {
      warnings.push({ line: lineNo, text: rawLine, reason: '没认出到场时段（如 08:00-11:00）' });
      return;
    }
    if (names.length === 0) {
      warnings.push({ line: lineNo, text: rawLine, reason: '没认出姓名' });
      return;
    }

    names.forEach((name) => {
      ranges.forEach((range) => {
        entries.push({ name, weekday: weekday as Weekday, startMinute: range.start, endMinute: range.end });
      });
    });
  });

  return { entries, warnings };
}

/** 构造日程包行（不写库，由 db 层落库） */
export function buildPackageDraft(rawText: string, parsed: ParsePackageResult): Omit<AvailabilityPackage, 'id' | 'active' | 'createdAt'> {
  const names = [...new Set(parsed.entries.map((entry) => entry.name))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  );
  const weekdays = [...new Set(parsed.entries.map((entry) => entry.weekday))].sort((a, b) => a - b);
  return {
    rawText,
    entries: parsed.entries,
    names,
    weekdays: weekdays as Weekday[],
    warnings: parsed.warnings.map((item) => `第 ${item.line} 行：${item.reason}（${item.text.trim()}）`),
  };
}

export function newPackageId(): string {
  return uuid();
}

export function packageStamp(): string {
  return nowIso();
}

/**
 * 外班日程包文本解析
 *
 * 外班给的包只有「姓名」和「可到场时段」两类信息，粘贴为纯文本，按行解析：
 * - 姓名行：不含时间区间的行视为新人员（如「霍连生」「张三、李四」可并列多人）
 * - 时段行：必须含时间区间，形如「周一 08:00-11:00」「周一8点到11点」「星期一 上午9:00 - 10:30」
 * - 分隔符：逗号 / 顿号 / 分号 / 空白 / 制表符均可
 * - 同一时段行也允许内联姓名，如「霍连生：周一 08:00-11:00」
 *
 * 解析失败必须抛出带行号的错误，供调用方保留草稿并允许原样重试。
 */
import type { AttendanceWindow } from '../types/rehearsal';
import type { Weekday } from '../types/operator';
import { DAY_BASE_HOUR } from '../types/operator';

/** 解析出的一条到场事实（未落库前的结构） */
export interface ParsedAttendance {
  personName: string;
  windows: AttendanceWindow[];
}

export interface ParseResult {
  /** 按出现顺序去重后的人员 */
  records: ParsedAttendance[];
  /** 命中的有效时段行数 */
  windowLineCount: number;
  /** 被忽略的空行 / 纯分隔行数 */
  blankLineCount: number;
}

const WEEKDAY_TOKEN: ReadonlyArray<{ pattern: RegExp; weekday: Weekday }> = [
  { pattern: /周\s*日|周\s*天|礼拜\s*日|星期\s*日|星期天/, weekday: 0 },
  { pattern: /周\s*一|礼拜\s*一|星期\s*一/, weekday: 1 },
  { pattern: /周\s*二|礼拜\s*二|星期\s*二/, weekday: 2 },
  { pattern: /周\s*三|礼拜\s*三|星期\s*三/, weekday: 3 },
  { pattern: /周\s*四|礼拜\s*四|星期\s*四/, weekday: 4 },
  { pattern: /周\s*五|礼拜\s*五|星期\s*五/, weekday: 5 },
  { pattern: /周\s*六|礼拜\s*六|星期\s*六/, weekday: 6 },
];

/** 拆分并列姓名的分隔符（逗号 / 顿号 / 分号 / 斜杠 / 空白） */
const NAME_SPLIT = /[、,，;；/／\s]+/;

/** 行内多个时段的分隔（句号 / 分号 / 逗号 / 顿号 / 斜杠），时间表达式内部不会出现这些字符 */
const SEGMENT_SPLIT = /[;；。]|(?<=\d)\s*[,，、/／]\s*(?=周|星期|礼拜)/;

/** 从一段文本里提取星期；识别不到返回 null */
export function parseWeekday(text: string): Weekday | null {
  for (const token of WEEKDAY_TOKEN) {
    if (token.pattern.test(text)) return token.weekday;
  }
  return null;
}

/** 「8点」「08:00」「8:00」「上午9点半」→ 当日小时分钟（24 小时制） */
function parseClock(text: string, meridiem: 'am' | 'pm' | null): { hour: number; minute: number } | null {
  const matched = /(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2})\s*分?)?/.exec(text);
  if (!matched) return null;
  let hour = Number.parseInt(matched[1], 10);
  const minuteText = matched[2];
  const minute = minuteText === undefined ? 0 : Number.parseInt(minuteText, 10);
  if (hour > 24 || minute > 59) return null;
  if (hour === 24) hour = 0;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function detectMeridiem(text: string): 'am' | 'pm' | null {
  if (/下午|晚上|晚间|午后|傍晚|pm|PM/i.test(text)) return 'pm';
  if (/上午|早上|早晨|清晨|午前|am|AM/i.test(text)) return 'am';
  return null;
}

/** 当日时刻 → 相对 08:00 的分钟偏移（可为负） */
function toMinuteOffset(hour: number, minute: number): number {
  return hour * 60 + minute - DAY_BASE_HOUR * 60;
}

/** 在一段文本里找出全部时间区间，逐段生成窗口（相对 08:00 的分钟偏移） */
function extractWindows(segment: string, rawLine: string, lineNo: number): AttendanceWindow[] {
  const weekday = parseWeekday(segment);
  if (weekday === null) return [];
  const meridiem = detectMeridiem(segment);
  const rangePattern =
    /(\d{1,2}\s*(?:\s*点\s*半|[:：点时]\s*\d{0,2}\s*分?)?)\s*[-—~～到至]+\s*(\d{1,2}\s*(?:\s*点\s*半|[:：点时]\s*\d{0,2}\s*分?)?)/g;
  const windows: AttendanceWindow[] = [];
  for (const range of segment.matchAll(rangePattern)) {
    const normalize = (token: string): { hour: number; minute: number } | null => {
      const half = token.includes('半') && !/分/.test(token);
      const cleaned = half ? token.replace('半', '30') : token;
      const clock = parseClock(cleaned, meridiem);
      if (!clock) return null;
      if (half && !/[:：]/.test(token)) clock.minute = 30;
      return clock;
    };
    const start = normalize(range[1]);
    const end = normalize(range[2]);
    if (!start || !end) continue;
    let startMinute = toMinuteOffset(start.hour, start.minute);
    let endMinute = toMinuteOffset(end.hour, end.minute);
    // 「11点-1点」这类跨午写法且未标下午时，结束按 +12 小时处理（外班包只描述当日到场）
    if (endMinute <= startMinute && meridiem === null) endMinute += 12 * 60;
    if (endMinute <= startMinute) {
      throw new Error(`第 ${lineNo} 行存在结束不晚于开始的时段：${range[0]}（${rawLine.trim()}）`);
    }
    windows.push({ weekday, startMinute, endMinute, rawText: rawLine.trim() });
  }
  return windows;
}

/** 判断一行里是否含时间区间表达式 */
function hasTimeRange(text: string): boolean {
  return /\d{1,2}\s*[:：点时]/.test(text) && /[-—~～到至]/.test(text);
}

/** 清洗姓名片段 */
function cleanName(token: string): string {
  return token
    .replace(/[()（）【】\[\]{}「」""'']/g, '')
    .replace(/^[\s:：·\-—]+|[\s:：·\-—]+$/g, '')
    .trim();
}

/**
 * 解析日程包全文。
 * @throws Error 第一条无法归属或无法识别的有效内容行会带行号报错
 */
export function parseAttendancePack(text: string): ParseResult {
  const lines = text.split(/\r\n?|\n/);
  const order: string[] = [];
  const byName = new Map<string, ParsedAttendance>();
  let windowLineCount = 0;
  let blankLineCount = 0;
  /** 最近一个姓名行声明的人员 */
  let currentNames: string[] = [];

  const ensurePerson = (name: string): ParsedAttendance => {
    let record = byName.get(name);
    if (!record) {
      record = { personName: name, windows: [] };
      byName.set(name, record);
      order.push(name);
    }
    return record;
  };

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (line === '') {
      blankLineCount += 1;
      return;
    }

    const weekday = parseWeekday(line);
    const isWindowLine = hasTimeRange(line);

    if (isWindowLine) {
      if (weekday === null) {
        throw new Error(`第 ${lineNo} 行有时间但缺少排练日（周一～周日），无法识别：${line}`);
      }
      // 时段行内可能内联了姓名（星期之前的部分，如「霍连生：周一 08:00-11:00」）
      const beforeWeekday = line.split(/周\s*[一二三四五六日天]|星期|礼拜/)[0] ?? '';
      const inlineNames = beforeWeekday
        .split(NAME_SPLIT)
        .map(cleanName)
        .filter((token) => token !== '' && !/\d/.test(token) && !/[:：]/.test(token));

      const segments = line
        .split(SEGMENT_SPLIT)
        .map((segment) => segment.trim())
        .filter((segment) => segment !== '');

      const windows: AttendanceWindow[] = [];
      segments.forEach((segment) => {
        windows.push(...extractWindows(segment, line, lineNo));
      });

      if (windows.length === 0) {
        throw new Error(`第 ${lineNo} 行的时段无法识别，请写成「周一 08:00-11:00」样式：${line}`);
      }

      const targets = inlineNames.length > 0 ? inlineNames : currentNames;
      if (targets.length === 0) {
        throw new Error(`第 ${lineNo} 行的时段没有归属姓名，请先写姓名行或在行内写明：${line}`);
      }
      targets.forEach((name) => ensurePerson(name).windows.push(...windows));
      windowLineCount += 1;
      return;
    }

    // 非时段行：视为姓名行（允许同一行并列多人）
    const names = line
      .replace(/[:：]\s*$/, '')
      .split(NAME_SPLIT)
      .map(cleanName)
      .filter((token) => token !== '' && parseWeekday(token) === null && !hasTimeRange(token));
    if (names.length === 0) {
      throw new Error(`第 ${lineNo} 行无法识别（既不像姓名也不含可到场时段）：${line}`);
    }
    currentNames = names;
    names.forEach((name) => ensurePerson(name));
  });

  const records = order.map((name) => byName.get(name) as ParsedAttendance);
  const withWindows = records.filter((record) => record.windows.length > 0);
  if (records.length === 0 || windowLineCount === 0 || withWindows.length === 0) {
    throw new Error('包内没有解析出任何「姓名 + 可到场时段」，请确认每行写法（如：霍连生 / 周一 08:00-11:00）');
  }
  return { records, windowLineCount, blankLineCount };
}

export function getLocalDate(
  date: Date,
  timeZone: string,
): string {
  const parts = getZonedDateParts(date, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(`无法按时区 ${timeZone} 解析时间`);
  }
  return { year, month, day, hour, minute };
}

export function shouldRunDailyCatchUp(
  cronExpression: string,
  timeZone: string,
  date: Date,
): boolean {
  const match = cronExpression
    .trim()
    .match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!match) return false;

  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return false;

  const local = getZonedDateParts(date, timeZone);
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

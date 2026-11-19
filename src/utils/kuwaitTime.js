export const KUWAIT_TIMEZONE = "Asia/Kuwait";
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const toKuwaitYmd = (input = new Date()) => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    const match = DATE_ONLY_RE.exec(trimmed);
    if (match) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
      };
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + KUWAIT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

export const startOfKuwaitDay = (input = new Date()) => {
  const ymd = toKuwaitYmd(input);
  if (!ymd) return new Date(NaN);
  return new Date(
    Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0, 0) - KUWAIT_OFFSET_MS,
  );
};

export const endOfKuwaitDay = (input = new Date()) => {
  const ymd = toKuwaitYmd(input);
  if (!ymd) return new Date(NaN);
  return new Date(
    Date.UTC(ymd.year, ymd.month - 1, ymd.day, 23, 59, 59, 999) -
      KUWAIT_OFFSET_MS,
  );
};

export const daysAgoKuwaitStart = (days = 0) => {
  const now = new Date();
  const target = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return startOfKuwaitDay(target);
};

export const formatKuwaitDate = (raw) => {
  if (!raw) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", {
    timeZone: KUWAIT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

export const formatKuwaitTime = (raw) => {
  if (!raw) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("en-US", {
    timeZone: KUWAIT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

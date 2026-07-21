// Working-day date arithmetic. Mon–Fri counted as working days, Sat/Sun
// skipped. Used to turn a service option's "N to M working days" delivery
// estimate into actual calendar dates from an activation date.

/** Add `days` working days to `from` (a Date, treated as local calendar date) and return a new Date. */
export function addWorkingDays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return result;
}

/** Format a Date as YYYY-MM-DD for a Postgres `date` column. */
export function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

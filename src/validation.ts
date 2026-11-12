export class ValidationError extends Error {
  override name = "ValidationError";
}

export function validateKeyName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError("name is required");
  }
  if (name.length > 120) throw new ValidationError("name must be <= 120 chars");
  return name.trim();
}

export function validateEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new ValidationError("endpoint is required");
  }
  if (endpoint.length > 300) throw new ValidationError("endpoint must be <= 300 chars");
  return endpoint.trim();
}

export function validateUnits(units: unknown): number {
  if (typeof units !== "number" || !Number.isInteger(units)) {
    throw new ValidationError("units must be an integer");
  }
  if (units < 1 || units > 1_000_000) {
    throw new ValidationError("units must be between 1 and 1000000");
  }
  return units;
}

export function validateTimestamp(ts: unknown, now: Date): string {
  if (ts === undefined || ts === null) return now.toISOString();
  if (typeof ts !== "string") throw new ValidationError("timestamp must be an ISO 8601 string");
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new ValidationError("timestamp is not a valid date");
  return d.toISOString();
}

export function validateMonth(month: unknown): string {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
    throw new ValidationError("month must be YYYY-MM");
  }
  const m = Number(month.slice(5, 7));
  if (m < 1 || m > 12) throw new ValidationError("month must be YYYY-MM");
  return month;
}

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

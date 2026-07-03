export type Query =
  | { readonly kind: "Device_status" }
  | { readonly kind: "Cursor_position" }
  | { readonly kind: "Other"; readonly value: number };

export const DeviceStatus: Query = { kind: "Device_status" };
export const CursorPosition: Query = { kind: "Cursor_position" };
export const Other = (value: number): Query => ({ kind: "Other", value });

export interface T {
  readonly query: Query;
}

export const ofParams = (params: readonly (number | undefined)[]): T | undefined => {
  if (params.length === 1) {
    const p = params[0];
    if (p === 5) return { query: DeviceStatus };
    if (p === 6) return { query: CursorPosition };
    if (p !== undefined) return { query: Other(p) };
  }
  return undefined;
};

const queryToParam = (q: Query): number => {
  switch (q.kind) {
    case "Device_status":
      return 5;
    case "Cursor_position":
      return 6;
    case "Other":
      return q.value;
  }
};

export const toString = (t: T): string => `\x1b[${queryToParam(t.query)}n`;

export const toStringHum = (t: T): string => {
  switch (t.query.kind) {
    case "Device_status":
      return "(DSR:device-status)";
    case "Cursor_position":
      return "(DSR:cursor-position)";
    case "Other":
      return `(DSR:${t.query.value})`;
  }
};

export const equal = (a: T, b: T): boolean => {
  if (a.query.kind !== b.query.kind) return false;
  if (a.query.kind === "Other" && b.query.kind === "Other") {
    return a.query.value === b.query.value;
  }
  return true;
};

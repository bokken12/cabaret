export type Action = "Set" | "Reset";

export interface T {
  readonly modes: readonly number[];
  readonly action: Action;
}

export const ofCsiParams = (params: readonly (number | undefined)[], terminal: string): T | undefined => {
  let action: Action | undefined;
  if (terminal === "h") action = "Set";
  else if (terminal === "l") action = "Reset";
  else return undefined;
  const modes = params.filter((p): p is number => p !== undefined);
  if (modes.length === 0) return undefined;
  return { modes, action };
};

const alternateScreenModes = [47, 1049];

export const isAlternateScreen = (t: T): boolean => t.modes.some((m) => alternateScreenModes.includes(m));

export const toString = (t: T): string => {
  const modesStr = t.modes.map(String).join(";");
  const actionChar = t.action === "Set" ? "h" : "l";
  return `\x1b[?${modesStr}${actionChar}`;
};

export const toStringHum = (t: T): string => {
  const modesStr = t.modes.map(String).join(";");
  const actionStr = t.action === "Set" ? "set" : "reset";
  return `(PrivateMode:${actionStr}:${modesStr})`;
};

export const equal = (a: T, b: T): boolean => {
  if (a.action !== b.action) return false;
  if (a.modes.length !== b.modes.length) return false;
  for (let i = 0; i < a.modes.length; i++) {
    if (a.modes[i] !== b.modes[i]) return false;
  }
  return true;
};

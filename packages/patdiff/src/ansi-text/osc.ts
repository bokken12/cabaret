export type Command =
  | { readonly kind: "Set_title"; readonly value: string }
  | { readonly kind: "Set_icon_name"; readonly value: string }
  | { readonly kind: "Set_working_directory"; readonly value: string }
  | { readonly kind: "Other"; readonly value: string };

export interface T {
  readonly command: Command;
}

export const SetTitle = (value: string): Command => ({ kind: "Set_title", value });
export const SetIconName = (value: string): Command => ({ kind: "Set_icon_name", value });
export const SetWorkingDirectory = (value: string): Command => ({
  kind: "Set_working_directory",
  value,
});
export const Other = (value: string): Command => ({ kind: "Other", value });

export const ofPayload = (payload: string): T => {
  const idx = payload.indexOf(";");
  if (idx >= 0) {
    const head = payload.slice(0, idx);
    const tail = payload.slice(idx + 1);
    switch (head) {
      case "0":
        return { command: SetTitle(tail) };
      case "2":
        return { command: SetTitle(tail) };
      case "1":
        return { command: SetIconName(tail) };
      case "7":
        return { command: SetWorkingDirectory(tail) };
    }
  }
  return { command: Other(payload) };
};

const payloadOfCommand = (c: Command): string => {
  switch (c.kind) {
    case "Set_title":
      return `0;${c.value}`;
    case "Set_icon_name":
      return `1;${c.value}`;
    case "Set_working_directory":
      return `7;${c.value}`;
    case "Other":
      return c.value;
  }
};

export const toString = (t: T): string => `\x1b]${payloadOfCommand(t.command)}\x1b\\`;

export const toStringHum = (t: T): string => {
  switch (t.command.kind) {
    case "Set_title":
      return `(OSC:title:${t.command.value})`;
    case "Set_icon_name":
      return `(OSC:icon:${t.command.value})`;
    case "Set_working_directory":
      return `(OSC:cwd:${t.command.value})`;
    case "Other":
      return `(OSC:${t.command.value})`;
  }
};

export const equal = (a: T, b: T): boolean => a.command.kind === b.command.kind && a.command.value === b.command.value;

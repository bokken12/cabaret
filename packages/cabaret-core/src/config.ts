export type ConfigScope = "local" | "global";
export type LandMethod = "merge" | "squash";

export class ConfigField<T> {
  public readonly name: string;
  public readonly key: string;
  public readonly scope: ConfigScope;
  public readonly defaultValue: T;

  private constructor(name: string, key: string, scope: ConfigScope, defaultValue: T) {
    this.name = name;
    this.key = key;
    this.scope = scope;
    this.defaultValue = defaultValue;
  }

  static readonly CONTEXT: ConfigField<number> = new ConfigField("context", "cabaret.context", "global", 3);
  static readonly HINTS: ConfigField<boolean> = new ConfigField("hints", "cabaret.hints", "global", true);
  static readonly LAND_VIA: ConfigField<LandMethod> = new ConfigField("land-via", "cabaret.landVia", "local", "merge");

  static readonly ALL: ReadonlyArray<ConfigField<unknown>> = [
    ConfigField.CONTEXT,
    ConfigField.HINTS,
    ConfigField.LAND_VIA,
  ];
}

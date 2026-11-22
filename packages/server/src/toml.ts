/** Encodes a string as a TOML basic string, escaping ASCII DEL (which TOML forbids). */
export function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007F');
}

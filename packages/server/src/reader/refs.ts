import type { ActTarget } from '@t3-tab/protocol';

/**
 * The refs one tab has handed out. A ref (`e12`) stands for one element of the current document and
 * keeps its number across reads, so unchanged lines stay identical and the diff stays small. The
 * table is dropped when the document is replaced.
 */
/** Most characters of an element's name kept to describe a step on it; the owner's prompt shows fewer. */
const TARGET_NAME_MAX = 120;

export class RefTable {
  private counter = 0;
  private readonly byBackend = new Map<number, string>();
  private readonly byRef = new Map<string, number>();
  private readonly targets = new Map<string, ActTarget>();

  /**
   * The ref for an element, made the first time it is printed. `target` is the role and name the line printed for it (the
   * tree the extension sent, redacted there), kept so a prompt can say which element a step acts on.
   */
  refFor(backendId: number, target?: ActTarget): string {
    const existing = this.byBackend.get(backendId);
    if (existing !== undefined) {
      if (target !== undefined) this.targets.set(existing, { role: target.role, name: target.name.slice(0, TARGET_NAME_MAX) });
      return existing;
    }
    this.counter += 1;
    const ref = `e${this.counter}`;
    this.byBackend.set(backendId, ref);
    this.byRef.set(ref, backendId);
    if (target !== undefined) this.targets.set(ref, { role: target.role, name: target.name.slice(0, TARGET_NAME_MAX) });
    return ref;
  }

  /** The role and name last printed for a ref, if it was printed with them. */
  targetOf(ref: string): ActTarget | undefined {
    return this.targets.get(ref);
  }

  /** How many refs the table has handed out. */
  get size(): number {
    return this.byRef.size;
  }

  backendIdOf(ref: string): number | undefined {
    return this.byRef.get(ref);
  }
}

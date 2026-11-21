/**
 * The refs one tab has handed out. A ref (`e12`) stands for one element of the current document and
 * keeps its number across reads, so unchanged lines stay identical and the diff stays small. The
 * table is dropped when the document is replaced.
 */
export class RefTable {
  private counter = 0;
  private readonly byBackend = new Map<number, string>();
  private readonly byRef = new Map<string, number>();

  refFor(backendId: number): string {
    const existing = this.byBackend.get(backendId);
    if (existing !== undefined) return existing;
    this.counter += 1;
    const ref = `e${this.counter}`;
    this.byBackend.set(backendId, ref);
    this.byRef.set(ref, backendId);
    return ref;
  }

  backendIdOf(ref: string): number | undefined {
    return this.byRef.get(ref);
  }
}

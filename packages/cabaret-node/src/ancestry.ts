import type { Revision } from "cabaret-core";

const TRUE = Promise.resolve(true);
const FALSE = Promise.resolve(false);

/**
 * Memoizes a backend's ancestry queries. Revisions name immutable commits,
 * so an answer, once computed, never goes stale — no invalidation, whatever
 * else the repository does. A merge-base also settles the ancestries around
 * it: it is an ancestor of both of its arguments, and one argument is an
 * ancestor of the other exactly when it is the merge-base itself, so those
 * queries are answered without ever running. Promises are cached, so
 * concurrent duplicates share one computation; a failed one is evicted
 * rather than pinning the error.
 */
export class AncestryCache {
  private readonly mergeBases = new Map<string, Promise<Revision>>();
  private readonly ancestries = new Map<string, Promise<boolean>>();

  /** The memoized merge-base of `a` and `b`, running `compute` on a miss. */
  mergeBase(a: Revision, b: Revision, compute: () => Promise<Revision>): Promise<Revision> {
    // Equal hashes name the same commit, trivially the last shared revision.
    if (a === b) {
      return Promise.resolve(a);
    }
    const cached = this.mergeBases.get(`${a} ${b}`);
    if (cached !== undefined) {
      return cached;
    }
    const pending = compute().then((base) => {
      this.ancestries.set(`${base} ${a}`, TRUE);
      this.ancestries.set(`${base} ${b}`, TRUE);
      this.ancestries.set(`${a} ${b}`, base === a ? TRUE : FALSE);
      this.ancestries.set(`${b} ${a}`, base === b ? TRUE : FALSE);
      return base;
    });
    // Both orders: any common ancestor either argument order yields is a
    // correct answer, and one consistent answer per pair beats two.
    this.mergeBases.set(`${a} ${b}`, pending);
    this.mergeBases.set(`${b} ${a}`, pending);
    pending.catch(() => {
      this.mergeBases.delete(`${a} ${b}`);
      this.mergeBases.delete(`${b} ${a}`);
    });
    return pending;
  }

  /** Whether `ancestor` is memoized as reachable from `descendant`, running `compute` on a miss. */
  isAncestor(ancestor: Revision, descendant: Revision, compute: () => Promise<boolean>): Promise<boolean> {
    // A revision is its own ancestor.
    if (ancestor === descendant) {
      return TRUE;
    }
    const key = `${ancestor} ${descendant}`;
    const cached = this.ancestries.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = compute();
    this.ancestries.set(key, pending);
    pending.catch(() => {
      // A merge-base resolving meanwhile settles this entry; evict only our
      // own failure, never that fact.
      if (this.ancestries.get(key) === pending) {
        this.ancestries.delete(key);
      }
    });
    return pending;
  }
}

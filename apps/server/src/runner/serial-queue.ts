/**
 * Runs async operations one at a time, in submission order. Used so that control
 * operations on a civilization (start, pause, step, snapshot, restore, reset,
 * delete) can never interleave.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

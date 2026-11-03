/**
 * キーごとに非同期処理を 1 つずつ順番に実行する。前の処理が失敗しても次は実行する。
 * 終わったキーは消すので、使ったキーの数だけ溜まり続けることはない。
 */
export class SerialQueue {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(() => fn());
    const tail = run.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }

  get size(): number {
    return this.#tails.size;
  }
}

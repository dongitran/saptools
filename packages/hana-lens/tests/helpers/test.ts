import { describe as nodeDescribe, it as nodeIt } from "node:test";

export function describe(name: string, callback: () => void): void {
  void nodeDescribe(name, callback);
}

export function it(name: string, callback: () => void | Promise<void>, timeout?: number): void {
  if (timeout === undefined) {
    void nodeIt(name, callback);
    return;
  }
  void nodeIt(name, { timeout }, callback);
}

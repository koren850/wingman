// Heap in use after a full collection, so a soak test does not depend on when the collector last ran (the whole suite shares one process).
import v8 from "node:v8";
import vm from "node:vm";

export function settledHeap(): number {
  try {
    v8.setFlagsFromString("--expose-gc");
    (vm.runInNewContext("gc") as () => void)();
  } catch {
    /* without a collector the raw number is used */
  }
  return process.memoryUsage().heapUsed;
}

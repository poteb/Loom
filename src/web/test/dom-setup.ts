import { afterEach } from "vitest";

// Unmount whatever a test rendered, so the next test queries a clean document. @testing-library's own
// auto-cleanup only registers itself when `afterEach` is a global, and this package runs vitest
// without globals — hence the explicit hook. Loaded only in the DOM environment (the test files that
// ask for happy-dom); the node-environment tests have no document and must not pull in the library.
if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/preact");
  afterEach(cleanup);
}

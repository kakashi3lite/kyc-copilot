// Removed: an over-restrictive `declare module "vitest"` ambient declaration
// previously lived here and shadowed vitest's real exported types (e.g.
// `afterEach`, `.rejects`, `.toBeGreaterThanOrEqual`). The real types are
// now picked up directly from the installed vitest package.
export {};
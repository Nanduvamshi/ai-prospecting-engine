/**
 * Jest was already a devDependency here, along with ts-jest, jsdom and
 * testing-library — only this config and the tests themselves were missing,
 * so `npm test` failed on a config that did not exist.
 *
 * Two things need handling that are specific to this project:
 *
 *  1. `server-only`. Half the modules worth testing import it as a build-time
 *     guard against leaking server code into a client bundle. Outside a Next
 *     build it throws on import, which would fail every suite before a single
 *     assertion ran. Mapping it to a no-op is the same trick the package
 *     itself uses via the `react-server` export condition, which is why the
 *     CLI scripts pass `--conditions react-server`.
 *
 *  2. The `@/` alias, which points at src/ exactly as tsconfig declares.
 *
 * The default environment is node because the code under test is server-side.
 * Component tests, when they exist, should opt in per-file with the
 * `@jest-environment jsdom` docblock rather than slowing every suite down.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^server-only$': '<rootDir>/tests/stubs/server-only.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
  },
  clearMocks: true,
};

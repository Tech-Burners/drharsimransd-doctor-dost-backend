/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // The first run downloads a mongod binary for mongodb-memory-server, so be generous.
  testTimeout: 60000,
  // Integration suites share one machine and each start a replica set. Run them serially
  // to keep ports and memory predictable.
  maxWorkers: 1,
  setupFiles: ['<rootDir>/src/test/setupEnv.ts'],
  // Type errors are reported as warnings so two pre-existing errors outside this phase
  // (otp/otp.utils.ts, utils/openAi.ts) do not block the suites. `npm run build` (tsc)
  // remains the type gate.
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { warnOnly: true } }],
  },
};

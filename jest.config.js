module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.[tj]sx?$": require.resolve('./test/jest-transformer')
  },
  coverageDirectory: "coverage",
  coverageProvider: 'v8',
  collectCoverageFrom: ["./src/**/*.ts"],
  verbose: true,
  testMatch: ["**/*.spec.(ts)"],
  // `**/*.spec.ts` also matches nested checkouts. A git worktree under .claude/
  // made every suite run twice, once from a stale copy of the sources, which is
  // indistinguishable in the output from the real one. Restates the built-in
  // /node_modules/ default, which setting this key would otherwise drop.
  testPathIgnorePatterns: ["/node_modules/", "/\\.claude/"],
  testEnvironment: "node",
  transformIgnorePatterns: [`/node_modules/(?!@babylonjs|@dcl)`],
}
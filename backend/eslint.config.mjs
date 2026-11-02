import { createRequire } from "node:module";
const frontend = createRequire(new URL("../frontend/package.json", import.meta.url));
// Reuse the workspace's installed TypeScript ESLint parser; no new dependency
// or package installation is needed for the separate backend application.
const typescript = frontend("eslint-config-next/typescript");
export default [
  { ignores: ["dist/**", "node_modules/**", "test/**", "scripts/**", "prisma.config.ts"] },
  ...typescript,
  { rules: { "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }] } },
  { files: ["src/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }] } },
];

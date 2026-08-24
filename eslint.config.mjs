/**
 * ESLint 扁平配置 —— 唯一目标：编译期拦截 React Hooks 铁律违规
 * （hooks 写在条件 return 之后 → 选中态切换时 hooks 数量变化 → 整窗白屏，本项目 2026-08 事故）。
 * 历史代码量大，只开 rules-of-hooks 一条 error，其余规则全部不启用，避免风格类噪音淹没致命问题。
 * 用法：pnpm lint（全量）/ npx eslint <文件>
 */
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**", "models/**"],
    // 历史代码里的 eslint-disable 注释引用了未启用的规则：不把它们报成 error，也不把注释本身报成 unused
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      // 注册 TS 插件：让既有代码里引用的 @typescript-eslint/* 规则名可被识别（声明为 off）
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Hooks 铁律：唯一强制开启的规则（白屏事故根因）
      "react-hooks/rules-of-hooks": "error",
      // 声明存在但不开：让既有代码里的 eslint-disable 注释合法（不声明则报「规则未定义」）
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);

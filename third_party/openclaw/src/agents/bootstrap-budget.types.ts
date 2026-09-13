// Source: https://github.com/openclaw/openclaw/blob/d972ecf3ddabad80d53599dfc501db12552cc3ca/src/agents/bootstrap-budget.types.ts
// Fetched: 2026-09-09 (openclaw main = d972ecf3ddabad80d53599dfc501db12552cc3ca) — MIT / Copyright (c) 2026 OpenClaw Foundation
// DO NOT EDIT. 上流の写し。取り直す: gh api repos/openclaw/openclaw/contents/src/agents/bootstrap-budget.types.ts --jq .content | base64 -d
export type BootstrapTruncationCause = "per-file-limit" | "total-limit";
export type BootstrapPromptWarningMode = "off" | "once" | "always";

export type BootstrapInjectionStat = {
  name: string;
  path: string;
  missing: boolean;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
};

type BootstrapAnalyzedFile = BootstrapInjectionStat & {
  effectiveFileLimit: number;
  nearLimit: boolean;
  causes: BootstrapTruncationCause[];
};

export type BootstrapBudgetAnalysis = {
  files: BootstrapAnalyzedFile[];
  truncatedFiles: BootstrapAnalyzedFile[];
  nearLimitFiles: BootstrapAnalyzedFile[];
  totalNearLimit: boolean;
  hasTruncation: boolean;
  totals: {
    rawChars: number;
    injectedChars: number;
    truncatedChars: number;
    bootstrapMaxChars: number;
    bootstrapTotalMaxChars: number;
    nearLimitRatio: number;
  };
};

export type BootstrapPromptWarning = {
  signature?: string;
  warningShown: boolean;
  lines: string[];
  warningSignaturesSeen: string[];
};

const KIND_ZH: Record<string, string> = {
  official_documentation: "官方文档",
  community_methodology: "社区经验",
  synthetic_case: "模拟案例",
};
const PLATFORM_ZH: Record<string, string> = {
  google: "Google",
  meta: "Meta（Facebook/Instagram）",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  programmatic: "程序化广告",
  general: "通用",
};
const REVIEW_ZH: Record<string, string> = { unreviewed: "未人工审核" };

/** 检索侧 glossary 的英文→中文，用于在英文片段下附术语对照（非全文翻译）。 */
const TERM_ZH: Record<string, string> = {
  budget: "预算", pacing: "进度", spend: "消耗/花费", bidding: "出价", attribution: "归因",
  conversion: "转化", tracking: "追踪/回传", creative: "素材/创意", fatigue: "疲劳",
  audience: "受众", targeting: "定向", ctr: "点击率", cpa: "每次转化费用", roas: "广告支出回报",
  campaign: "广告系列", ad: "广告", ads: "广告", impression: "展示", click: "点击",
  optimize: "优化", optimization: "优化", diagnose: "诊断", audit: "审计",
};

export function kindZh(kind: string): string { return KIND_ZH[kind] ?? kind; }
export function platformsZh(platforms: string[]): string[] { return platforms.map(p => PLATFORM_ZH[p] ?? p); }
export function reviewZh(status: string): string { return REVIEW_ZH[status] ?? status; }

/** 在英文正文里为常见投放术语追加中文，便于对照阅读。 */
export function annotateTermsEnglish(text: string): string {
  let out = text;
  const keys = Object.keys(TERM_ZH).sort((a, b) => b.length - a.length);
  for (const en of keys) {
    const zh = TERM_ZH[en]!;
    out = out.replace(new RegExp(`\\b(${en})\\b`, "gi"), (match) => `${match}（${zh}）`);
  }
  return out;
}

export type ZhResultView = {
  kind: string;
  platforms: string[];
  review_status: string;
  language: string;
  title: string;
  section_path: string;
  matched_window: string;
  body_note: string | null;
};

export function zhResultView(language: string, title: string, section: string[], kind: string, platforms: string[],
  review_status: string, matchedWindow: string): ZhResultView {
  const isZh = language === "zh";
  return {
    kind: kindZh(kind),
    platforms: platformsZh(platforms),
    review_status: reviewZh(review_status),
    language: isZh ? "中文" : "英文",
    title,
    section_path: section.join(" / "),
    matched_window: isZh ? matchedWindow : annotateTermsEnglish(matchedWindow),
    body_note: isZh ? null : "命中正文为英文原文；matched_window 为原文，此处为术语加注对照，不是完整翻译。",
  };
}

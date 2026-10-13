import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export type Section = { headings: string[]; lineStart: number; lineEnd: number; blocks: string[] };
const excludedHeading = /^(?:contents|table of contents|installation|install|license|contributing|related skills|related collections|author|changelog|resources|目录|安装|许可证|贡献)(?:\s|$)/i;

/** Sections retain paragraph/list/table/code blocks. Oversized blocks are flagged, never sliced silently. */
export function markdownSections(markdown: string): { title: string; sections: Section[]; removedSections: string[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) throw new Error("INVALID_FRONTMATTER");
    start = end + 1;
  }
  const sections: Section[] = [];
  const removedSections: string[] = [];
  const headings: string[] = [];
  let title = ""; let ignoredLevel = 0; let fence: string | undefined; let fenceSize = 0;
  let section: Section | undefined; let block: string[] = [];
  const flushBlock = () => {
    const text = block.join("\n").trim();
    if (text && !/^!\[[^\]]*\]\([^)]*\)$/.test(text) && !/^(?:[-*_]\s*){3,}$/.test(text)) section?.blocks.push(text);
    block = [];
  };
  const flushSection = () => { flushBlock(); if (section?.blocks.length) sections.push(section); section = undefined; };
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence && marker.length >= fenceSize))) {
      if (ignoredLevel) continue;
      if (!section) section = { headings: [...headings], lineStart: index + 1, lineEnd: index + 1, blocks: [] };
      section.lineEnd = index + 1;
      block.push(line);
      if (fence) { fence = undefined; flushBlock(); } else { fence = marker[0]; fenceSize = marker.length; }
      continue;
    }
    if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = heading[1]!.length; const text = heading[2]!.trim();
        if (ignoredLevel && level > ignoredLevel) continue;
        ignoredLevel = 0; flushSection();
        headings.length = level - 1; headings[level - 1] = text;
        if (!title && level === 1) title = text;
        if (excludedHeading.test(text)) { ignoredLevel = level; removedSections.push(text); continue; }
        section = { headings: headings.filter(Boolean), lineStart: index + 1, lineEnd: index + 1, blocks: [] };
        continue;
      }
      if (ignoredLevel) continue;
      if (!line.trim()) { flushBlock(); continue; }
      if (/^<!--.*-->\s*$/.test(line)) continue;
    }
    if (!section) section = { headings: headings.filter(Boolean), lineStart: index + 1, lineEnd: index + 1, blocks: [] };
    section.lineEnd = index + 1; block.push(line);
  }
  if (fence) throw new Error("UNCLOSED_CODE_FENCE");
  flushSection();
  return { title, sections, removedSections };
}

export function chunkSections(sections: Section[], targetChars = 2200): Array<Section & { text: string; oversized: boolean }> {
  const chunks: Array<Section & { text: string; oversized: boolean }> = [];
  for (const section of sections) {
    const prefix = section.headings.map((heading, index) => `${"#".repeat(index + 1)} ${heading}`).join("\n");
    let blocks: string[] = [];
    const flush = () => {
      if (!blocks.length) return;
      const text = [prefix, ...blocks].filter(Boolean).join("\n\n");
      chunks.push({ ...section, blocks, text, oversized: text.length > targetChars }); blocks = [];
    };
    for (const block of section.blocks) {
      if (blocks.length && prefix.length + blocks.join("\n\n").length + block.length + 4 > targetChars) flush();
      blocks.push(block);
    }
    flush();
  }
  return chunks;
}

/** Extract only Google Developers article content, preserving headings, rows and code. */
export function googleArticle(html: string): { markdown: string; title: string; updated: string | null; licenseEvidence: string } {
  const { document } = parseHTML(html);
  const licenseLink = document.querySelector('a[href*="creativecommons.org/licenses/by/4.0"]');
  if (!licenseLink) throw new Error("LICENSE_NOT_CONFIRMED");
  const article = document.querySelector(".devsite-article-body");
  if (!article) throw new Error("ARTICLE_BODY_MISSING");
  for (const node of document.querySelectorAll("devsite-actions, devsite-feature-tooltip")) node.remove();
  const title = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("ARTICLE_TITLE_MISSING");
  const updated = /(?:Last updated|最后更新时间|上次更新)[^\d]*(\d{4}-\d{2}-\d{2})/.exec(document.textContent ?? html)?.[1] ?? null;
  for (const node of article.querySelectorAll("script, style, nav, button, svg, .material-icons, .devsite-feedback, devsite-feedback, .devsite-summary, .devsite-article-meta")) node.remove();
  // Lightweight DOM -> Markdown conversion: formatting only, no scripts are evaluated.
  const render = (node: { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<unknown> }): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    const tag = node.nodeName.toLowerCase();
    if (tag === "table") {
      const table = node as unknown as { querySelectorAll(selector: string): ArrayLike<{ querySelectorAll(selector: string): ArrayLike<{ childNodes: ArrayLike<unknown> }> }> };
      const rows = Array.from(table.querySelectorAll("tr")).map(row => Array.from(row.querySelectorAll("th, td"))
        .map(cell => Array.from(cell.childNodes).map(child => render(child as typeof node)).join("").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const header = rows[0]!;
      return `\n\n${[header, header.map(() => "---"), ...rows.slice(1)].map(row => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
    }
    const text = Array.from(node.childNodes).map(child => render(child as typeof node)).join("");
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === "pre") {
      const code = node.textContent ?? "";
      const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), match => match[0].length));
      const fence = "`".repeat(longest + 1);
      return `\n\n${fence}\n${code.trim()}\n${fence}\n\n`;
    }
    if (tag === "code") return `\`${text}\``;
    if (tag === "li") return `\n- ${text.trim()}\n`;
    if (tag === "td" || tag === "th") return ` ${text.trim().replace(/\|/g, "\\|")} |`;
    if (tag === "tr") return `\n|${text}\n`;
    if (["table", "p", "div", "ul", "ol", "aside", "blockquote"].includes(tag)) return `\n\n${text.trim()}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "a") {
      const rawHref = (node as unknown as { getAttribute: (name: string) => string | null }).getAttribute("href");
      if (rawHref && /^https?:\/\//.test(rawHref) && text.trim()) return `[${text.trim()}](${rawHref})`;
    }
    return text;
  };
  const body = render(article).replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length < 150) throw new Error("ARTICLE_TOO_SHORT");
  return { title, updated, licenseEvidence: licenseLink.getAttribute("href")!, markdown: `# ${title}\n\n${body}\n` };
}

export function classify(text: string): { platforms: string[]; topics: string[]; language: string } {
  const platforms = [
    ["google", /google|谷歌|adwords/i], ["meta", /\bmeta\b|facebook|instagram/i],
    ["tiktok", /tiktok|抖音|巨量/i], ["linkedin", /linkedin/i], ["programmatic", /\bDSP\b|\bSSP\b|\bADX\b|程序化/],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string);
  const topics = [
    ["budget", /budget|pacing|spend|预算|消耗/i], ["bidding", /bid(?:ding)?|出价|竞价/i],
    ["conversion_tracking", /conversion|attribution|tracking|转化|归因|回传/i],
    ["diagnosis", /diagnos|audit|fatigue|异常|诊断|排查|审计/i], ["creative", /creative|素材|创意|文案/i],
    ["audience", /audience|targeting|受众|定向/i], ["experiment", /experiment|a\/b|测试|实验/i],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string);
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return { platforms: platforms.length ? platforms : ["general"], topics: topics.length ? topics : ["strategy"],
    language: chinese > 100 || chinese > text.length * 0.1 ? "zh" : "en" };
}

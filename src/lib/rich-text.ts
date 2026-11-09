/**
 * Long text from people and job sources, shown as safe Markdown (D591).
 *
 * - `htmlToMarkdown`: a source's HTML into Markdown at import time, so
 *   headings, paragraphs, lists, bold and links survive. No DOM, no
 *   dependency: a small tag walker; anything it does not know is text.
 * - `toMarkdown`: any stored text (old flat imports, plain text from a form,
 *   new Markdown) into tidy Markdown before render. Deterministic, no LLM.
 * - `markdownToPlain`: the same text without marks, for cards and meta tags.
 */

/** Imported descriptions stay this short (13.2). */
export const IMPORTED_TEXT_MAX = 8000;

// ── HTML → Markdown (import) ───────────────────────────────────────────

const DROPPED_WITH_CONTENT =
  /<(script|style|iframe|noscript|svg|template|object|embed|head|title|select|button|form)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TOKEN =
  /<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;

const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "dl",
  "dd",
  "dt",
  "figure",
  "figcaption",
  "address",
  "center",
]);

const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  times: "×",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwj: "",
  zwnj: "",
};

/** HTML entities into characters; unknown ones stay as written. */
export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED[body.toLowerCase()] ?? whole;
    },
  );
}

/** Characters that would turn plain words into Markdown. */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>#|~]/g, "\\$&");
}

function attribute(attrs: string, name: string): string {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(attrs);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/** An http(s) address, or null: no `javascript:`, `data:` or site paths. */
export function safeExternalHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

type Inline = { kind: "strong" | "em" | "a"; start: number; href?: string };

/** Cut at the last line break before `max`, so no half mark is left. */
function cutAt(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const line = cut.lastIndexOf("\n");
  return (line > max * 0.6 ? cut.slice(0, line) : cut).trim();
}

/**
 * A source's HTML as Markdown: h1–h6 → `###`/`####`, p and div →
 * paragraphs, ul/ol → lists (nested by two spaces), b/strong → `**`,
 * i/em → `*`, a → `[text](https://…)`. Scripts, styles, frames and images
 * are dropped. At most 8000 characters (13.2).
 */
export function htmlToMarkdown(
  html: string,
  max: number = IMPORTED_TEXT_MAX,
): string {
  const source = html.replace(COMMENT, " ").replace(DROPPED_WITH_CONTENT, " ");
  let out = "";
  const lists: { ordered: boolean; count: number }[] = [];
  const inline: Inline[] = [];
  let heading = false;
  let pre = 0;

  const atLineStart = () => out === "" || out.endsWith("\n");
  const breakBlock = () => {
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
  };
  const breakLine = () => {
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const closeInline = (kind: Inline["kind"]) => {
    const index = inline.map((item) => item.kind).lastIndexOf(kind);
    if (index < 0) return;
    const [open] = inline.splice(index);
    if (!open) return;
    const content = out.slice(open.start);
    const body = content.trim();
    const lead = content.match(/^\s*/)?.[0] ? " " : "";
    const tail = /\s$/.test(content) ? " " : "";
    let next = body;
    if (body && kind === "a") {
      const href = safeExternalHref(open.href);
      next = href
        ? `[${body}](${href.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`
        : body;
    } else if (body && !heading && !body.includes("\n")) {
      const mark = kind === "strong" ? "**" : "*";
      next = `${mark}${body}${mark}`;
    }
    out = `${out.slice(0, open.start)}${lead}${next}${tail}`;
  };

  for (const match of source.matchAll(TOKEN)) {
    const [whole, rawName, attrs = ""] = match;
    if (!rawName) {
      const raw = decodeEntities(whole);
      if (pre > 0) {
        out += raw;
        continue;
      }
      let value = escapeMarkdown(raw.replace(/\s+/g, " "));
      if (atLineStart()) value = value.trimStart();
      if (value) out += value;
      continue;
    }
    const name = rawName.toLowerCase();
    const closing = whole.startsWith("</");
    if (name === "br") {
      breakLine();
    } else if (name === "hr") {
      breakBlock();
    } else if (/^h[1-6]$/.test(name)) {
      breakBlock();
      heading = !closing;
      if (!closing) out += Number(name[1]) <= 3 ? "### " : "#### ";
    } else if (name === "ul" || name === "ol") {
      if (closing) {
        lists.pop();
        if (lists.length === 0) breakBlock();
        else breakLine();
      } else {
        if (lists.length === 0) breakBlock();
        else breakLine();
        lists.push({ ordered: name === "ol", count: 0 });
      }
    } else if (name === "li") {
      breakLine();
      if (!closing) {
        const list = lists.at(-1) ?? { ordered: false, count: 0 };
        list.count += 1;
        const depth = Math.max(0, lists.length - 1);
        out += `${"  ".repeat(depth)}${list.ordered ? `${list.count}.` : "-"} `;
      }
    } else if (name === "tr") {
      breakLine();
    } else if (name === "td" || name === "th") {
      if (closing) out += " · ";
    } else if (BLOCK.has(name)) {
      breakBlock();
      if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    } else if (name === "strong" || name === "b") {
      if (closing) closeInline("strong");
      else inline.push({ kind: "strong", start: out.length });
    } else if (name === "em" || name === "i") {
      if (closing) closeInline("em");
      else inline.push({ kind: "em", start: out.length });
    } else if (name === "a") {
      if (closing) closeInline("a");
      else
        inline.push({
          kind: "a",
          start: out.length,
          href: attribute(attrs, "href"),
        });
    }
    // img, span, font and the rest: their text stays, the tag goes.
  }
  while (inline.length) closeInline(inline.at(-1)!.kind);

  const markdown = out
    .split("\n")
    .map((line) => line.replace(/( · )+$/, "").trimEnd())
    .filter((line) => !/^\s*(?:-|\d+\.)\s*$/.test(line))
    .join("\n")
    .replace(/^#{3,4} *$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cutAt(markdown, max);
}

// ── Any stored text → tidy Markdown (render) ───────────────────────────

const BULLET = /^([•·▪◦●‣∙○■□➢➤►▶✓✔✅→]\s*|[-*+–—]\s+)(.+)$/u;
const ORDERED = /^(\d{1,2})[.)]\s+(.+)$/;
const FACT = /^(Salary|Compensation|Location|Pay|Зарплата|Локация):\s/i;

/** Section names that open a block in a job post (en and ru). */
const SECTIONS = [
  "About (?:the |this )?(?:role|job|position|team|company|us|you)",
  "About",
  "(?:Key |Main |Your )?Responsibilities",
  "(?:Key |Minimum |Preferred |Basic )?(?:Requirements|Qualifications)",
  "What (?:you(?:'|’)ll|you will) (?:do|bring|need|get)",
  "What we(?:'|’)re looking for",
  "What we (?:offer|look for)",
  "Who you are",
  "(?:The |Your )?Role",
  "Nice to have",
  "Bonus points",
  "(?:Benefits|Perks)(?: and Perks| & Perks| and Benefits)?",
  "Why (?:join us|you(?:'|’)ll love working here|work with us)",
  "How to apply",
  "Skills",
  "Tech stack",
  "Обязанности",
  "Требования",
  "Условия",
  "Мы предлагаем",
  "О компании",
  "О нас",
  "Задачи",
  "Будет плюсом",
].join("|");

const SECTION_LEAD = new RegExp(`^(${SECTIONS}):\\s*(.*)$`, "i");
const SECTION_INLINE = new RegExp(
  `(?<=[.!?:;)])\\s+(?=(?:${SECTIONS}):\\s)`,
  "gi",
);

/** "…mentor engineers Requirements: …": a capitalised section after a word. */
const SECTION_AFTER_WORD = new RegExp(
  `(?<=[a-zа-яё0-9])\\s+(?=(?:${SECTIONS}):\\s)`,
  "gu",
);

/**
 * Old imports were flattened into one line (D591): put line breaks back
 * before inline bullets, known section names and the facts we append.
 */
function unflatten(line: string): string {
  return line
    .replace(/\s+(?=[•▪◦●‣➢➤►✓✔✅]\s*\S)/gu, "\n")
    .replace(SECTION_INLINE, "\n")
    .replace(SECTION_AFTER_WORD, "\n")
    .replace(/\s+(?=(?:Salary|Compensation|Location): )/g, "\n");
}

/** A paragraph longer than this is split at sentence ends. */
const LONG_PARAGRAPH = 700;
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9"“(])/u;

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= LONG_PARAGRAPH) return [paragraph];
  const parts: string[] = [];
  let current = "";
  for (const sentence of paragraph.split(SENTENCE_END)) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.length >= 320) {
      parts.push(current);
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts;
}

function isHeading(line: string): string | null {
  if (line.length > 60) return null;
  if (/^[A-ZА-ЯЁ][^.!?]{1,58}:$/u.test(line) && line.split(/\s+/).length <= 7)
    return line.slice(0, -1).trim();
  // "RESPONSIBILITIES", "WHAT WE OFFER"
  if (/^[A-ZА-ЯЁ0-9 &/'’,-]{4,40}$/u.test(line) && /[A-ZА-ЯЁ]{3}/u.test(line))
    return line.trim();
  return null;
}

/**
 * Text as Markdown a reader can scan: one paragraph per line, bullet-like
 * lines as lists, short "Title:" lines as headings, very long paragraphs
 * split at sentence ends. Markdown that is already there stays.
 */
export function toMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  let source = text.replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  if (!source.includes("\n") || source.length / source.split("\n").length > 900)
    source = source.split("\n").map(unflatten).join("\n");

  const out: string[] = [];
  type Mode = "none" | "list" | "table" | "fence";
  let mode = "none" as Mode;
  const block = (next: Mode) => {
    if (out.length && out.at(-1) !== "") out.push("");
    mode = next;
  };

  for (const raw of source.split("\n")) {
    const indentRaw = raw.match(/^\s*/)?.[0] ?? "";
    const line = raw.trim();
    if (mode === "fence") {
      out.push(raw);
      if (line.startsWith("```")) mode = "none";
      continue;
    }
    if (!line) {
      if (mode !== "list") block("none");
      continue;
    }
    if (line.startsWith("```")) {
      block("fence");
      out.push(line);
      continue;
    }
    if (line.startsWith("|")) {
      if (mode !== "table") block("table");
      out.push(line);
      continue;
    }
    const indent = "  ".repeat(Math.min(3, Math.floor(indentRaw.length / 2)));
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      if (mode !== "list") block("list");
      out.push(
        bullet
          ? `${mode === "list" ? indent : ""}- ${bullet[2]!.trim()}`
          : `${mode === "list" ? indent : ""}${ordered![1]}. ${ordered![2]!.trim()}`,
      );
      continue;
    }
    if (/^(#{1,6}\s|>)/.test(line)) {
      block("none");
      out.push(line);
      continue;
    }
    const lead = SECTION_LEAD.exec(line);
    if (lead && !FACT.test(line)) {
      block("none");
      out.push(`### ${lead[1]!.trim()}`);
      if (lead[2]?.trim()) {
        out.push("");
        out.push(...splitLong(lead[2].trim()).flatMap((p) => [p, ""]));
        out.pop();
      }
      continue;
    }
    const heading = isHeading(line);
    if (heading) {
      block("none");
      out.push(`### ${heading}`);
      continue;
    }
    block("none");
    out.push(...splitLong(line).flatMap((p) => [p, ""]));
    out.pop();
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Markdown → plain (cards, meta) ─────────────────────────────────────

/** The text without Markdown marks, on one line, for a card or a meta tag. */
export function markdownToPlain(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+•·▪◦●]\s+|\d{1,2}[.)]\s+)/gmu, "")
    .replace(/(?<!\w)(\*\*|__|\*|_|~~|`)(?=\S)([\s\S]*?\S)\1(?!\w)/g, "$2")
    .replace(/\\([\\`*_[\]<>#|~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

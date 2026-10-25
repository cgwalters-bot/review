// The news pane: recently merged PRs in the repositories that make up
// the bot and this app, newest first, with harness changes marked. Pure
// parsing here, plus the reads, conditional (ETags) and cached: a merged
// PR's files don't change.

import type { GitHub } from "./api.ts";
import { FETCH_CONCURRENCY, NEWS_PER_REPO, NEWS_REPOS } from "./config.ts";
import { MAX_FILE_PAGES, mapLimit } from "./prs.ts";

/** A label that marks a PR as a harness change. */
export const HARNESS_LABEL = "harness";
/** Paths whose change makes a PR a harness change: agent.yml, bot-harness, a harness/ tree. */
const HARNESS_PATH_RE = /(?:^|\/)agent\.ya?ml$|(?:^|\/)bot-harness(?:\/|$)|(?:^|\/)harness\//;

export interface NewsItem {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  mergedAt: string;
  /** The body's first paragraph, as markdown. */
  summary: string;
  labels: string[];
  /** Labeled harness, or touching harness paths (once files are read). */
  harness: boolean;
}

export interface RawNewsPull {
  number: number;
  html_url: string;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  merged_at?: string | null;
  labels?: { name?: string }[];
}

/**
 * The first paragraph of a PR body: HTML comments and leading headings,
 * rules and blank lines skipped, ending at a blank line.
 */
export function firstParagraph(body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^\s*(?:#.*|-{3,}|\*{3,}|_{3,})?\s*$/.test(lines[i] ?? "")) i++;
  const para: string[] = [];
  for (; i < lines.length && (lines[i] ?? "").trim() !== ""; i++) para.push(lines[i] ?? "");
  const out = para.join("\n").trim();
  return out;
}

export function isHarnessPath(path: string): boolean {
  return HARNESS_PATH_RE.test(path);
}

/** A merged PR as a news item, or undefined if it wasn't merged. */
export function parseNewsPull(repo: string, raw: RawNewsPull): NewsItem | undefined {
  if (!raw.merged_at) return undefined;
  const labels = (raw.labels ?? []).flatMap((l) => (l.name ? [l.name] : []));
  return {
    repo,
    number: raw.number,
    url: raw.html_url,
    title: raw.title?.trim() || "(no title)",
    author: raw.user?.login ?? "ghost",
    mergedAt: raw.merged_at,
    summary: firstParagraph(raw.body ?? ""),
    labels,
    harness: labels.includes(HARNESS_LABEL),
  };
}

/** Newest merge first, then by repository and number for stability. */
export function sortNews(items: readonly NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || a.repo.localeCompare(b.repo) || b.number - a.number);
}

export interface News {
  items: NewsItem[];
  /** Repositories that couldn't be read (e.g. private to this token). */
  warnings: string[];
  changed: boolean;
}

/** Whether each merged PR touched harness paths, by `repo#number`; merged PRs never change. */
export type HarnessCache = Map<string, boolean>;

/**
 * The newest merged PRs across NEWS_REPOS. One conditional list per
 * repository (304s cost nothing); files only for PRs not seen before
 * and not already labeled.
 */
export async function loadNews(gh: GitHub, cache: HarnessCache, limit: number): Promise<News> {
  const warnings: string[] = [];
  let changed = false;
  const lists = await mapLimit(NEWS_REPOS, FETCH_CONCURRENCY, async (repo) => {
    try {
      const r = await gh.get<RawNewsPull[]>(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${NEWS_PER_REPO}`);
      changed ||= r.changed;
      return r.data.flatMap((p) => parseNewsPull(repo, p) ?? []);
    } catch (e) {
      warnings.push(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  });
  const items = sortNews(lists.flat()).slice(0, limit);
  const unknown = items.filter((n) => !n.harness && !cache.has(`${n.repo}#${n.number}`));
  await mapLimit(unknown, FETCH_CONCURRENCY, async (n) => {
    try {
      const files = await gh.getAll<{ filename: string; previous_filename?: string }>(`/repos/${n.repo}/pulls/${n.number}/files?per_page=100`, MAX_FILE_PAGES);
      cache.set(`${n.repo}#${n.number}`, files.data.some((f) => isHarnessPath(f.filename) || isHarnessPath(f.previous_filename ?? "")));
      changed = true;
    } catch {
      // Unmarked is the safe default; try again next time.
    }
  });
  for (const n of items) n.harness ||= cache.get(`${n.repo}#${n.number}`) === true;
  return { items, warnings, changed };
}

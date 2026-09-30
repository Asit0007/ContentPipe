/**
 * briefPageFiles.ts — the file side of server/briefPage.ts: write exports/<name>.html beside a brief, and
 * exports/index.html listing every brief. Kept apart from briefPage.ts so the renderer stays pure.
 */
import fs from 'fs/promises';
import path from 'path';
import { renderBriefIndex, renderBriefPage, summarizeBrief, type BriefIndexItem } from './briefPage';

const pageName = (mdName: string): string => mdName.replace(/\.md$/, '.html');

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** Render one brief's page beside it. Returns the page's path. */
export async function writeBriefPage(mdPath: string): Promise<string> {
  const name = path.basename(mdPath);
  const out = path.join(path.dirname(mdPath), pageName(name));
  await writeAtomic(out, renderBriefPage(await fs.readFile(mdPath, 'utf8'), name));
  return out;
}

/** Rebuild index.html from every .md in `dir`; with `rebuildPages`, every brief's own page too. */
export async function writeBriefIndex(opts: { dir?: string; rebuildPages?: boolean } = {}): Promise<{ indexPath: string; pages: number }> {
  const dir = opts.dir ?? path.resolve(process.cwd(), 'exports');
  await fs.mkdir(dir, { recursive: true });
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
  const items: BriefIndexItem[] = [];
  let pages = 0;
  for (const name of names) {
    const mdPath = path.join(dir, name);
    const [md, st] = await Promise.all([fs.readFile(mdPath, 'utf8'), fs.stat(mdPath)]);
    const html = path.join(dir, pageName(name));
    const missing = await fs.access(html).then(() => false, () => true);
    if (opts.rebuildPages || missing) { await writeAtomic(html, renderBriefPage(md, name)); pages++; }
    items.push({ href: encodeURI(pageName(name)), fileName: name, modified: st.mtime.toISOString(), bytes: st.size, summary: summarizeBrief(md) });
  }
  const indexPath = path.join(dir, 'index.html');
  await writeAtomic(indexPath, renderBriefIndex(items));
  return { indexPath, pages };
}

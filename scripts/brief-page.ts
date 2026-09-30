/**
 * brief-page.ts — write a readable HTML page beside every exported brief, plus an index of them all.
 *
 *   npm run brief:page                      # every exports/*.md -> exports/<name>.html, and exports/index.html
 *   npm run brief:page -- exports/x.md      # just that brief (the index is still rebuilt)
 *
 * The pages are self-contained (no network, no server): open exports/index.html in a browser. They are a view
 * of the Markdown, which stays the source; re-run this after editing a brief by hand. New exports get their
 * page automatically (server/markdownExporter.ts calls the same writer).
 */
import path from 'path';
import { EXPORTS_DIR } from '../server/markdownExporter';
import { writeBriefPage, writeBriefIndex } from '../server/briefPageFiles';

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

async function main() {
  for (const file of only) {
    const abs = path.resolve(file);
    if (path.dirname(abs) !== EXPORTS_DIR || !abs.endsWith('.md')) throw new Error(`Not a brief in exports/: ${file}`);
    console.log(`wrote ${path.relative(process.cwd(), await writeBriefPage(abs))}`);
  }
  const { indexPath, pages } = await writeBriefIndex({ rebuildPages: only.length === 0 });
  if (only.length === 0) console.log(`wrote ${pages} brief page(s)`);
  console.log(`wrote ${path.relative(process.cwd(), indexPath)}  — open it in a browser`);
}

main().catch((err) => { console.error(err?.message || err); process.exit(1); });

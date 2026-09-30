/**
 * briefPage.ts — turns an exported brief (the Markdown in exports/) into one self-contained HTML page.
 *
 * Why: a 9-minute script exports to ~500 KB of Markdown (51 scenes, six prompts each). As a file it is a
 * wall of text; what the owner needs while making a video is a dashboard: the numbers and warnings at the
 * top, sections that fold away, one row per scene, and a Copy button on every prompt.
 *
 * It reads the Markdown, not the script JSON, on purpose: every brief ever exported can be rendered, and
 * the page can never say something the brief does not. The renderer below covers exactly the Markdown
 * shapes server/markdownExporter.ts writes (headings, pipe tables, fenced code, quotes, lists, task items,
 * <details>) — it is not a general Markdown engine.
 *
 * Security: a brief quotes fetched web pages, which for this channel are often attacker-authored. Every
 * piece of text is HTML-escaped before anything else happens, links are limited to http(s), and the page
 * ships a Content-Security-Policy that allows no network access at all. Pure: no I/O, no dependencies.
 */

export interface BriefSummary {
  title: string;
  hook: string;
  meta: Record<string, string>;
  checks: { error: number; warn: number; info: number };
  sceneCount: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Inline Markdown on ONE line of text. Escapes first, so nothing in the source can become markup. */
export function inlineMd(raw: string): string {
  const codes: string[] = [];
  let s = esc(raw.replace(/\\\|/g, '|'));
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => link(u, t));
  s = s.replace(/(^|[\s(|])(https?:\/\/[^\s<|]+[^\s<|.,;:)])/g, (_m, pre: string, u: string) => `${pre}${link(u, u)}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // `_x_` only as a whole phrase: identifiers like untrusted_app must survive.
  s = s.replace(/(^|[\s(>])_([^_\s][^_]*)_(?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

// `u` and `t` arrive already escaped; an escaped quote cannot close the attribute.
const link = (u: string, t: string): string => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;

export function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
  }
  return { meta, body: md.slice(m[0].length) };
}

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

const SEVERITY = new Set(['ERROR', 'WARN', 'INFO']);

/** Block-level Markdown -> HTML for the shapes the exporter writes. */
export function mdToHtml(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();

    if (t.startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!);
      i++;
      out.push(`<div class="code"><button type="button" class="copy">Copy</button><pre>${esc(code.join('\n'))}</pre></div>`);
      continue;
    }
    if (t === '') { flush(); i++; continue; }
    if (/^-{3,}$/.test(t)) { flush(); i++; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { flush(); const n = Math.min(h[1]!.length + 1, 6); out.push(`<h${n}>${inlineMd(h[2]!)}</h${n}>`); i++; continue; }

    const det = /^<details>\s*<summary>(.*?)<\/summary>\s*$/.exec(t);
    if (det) { flush(); out.push(`<details class="sub"><summary>${inlineMd(det[1]!)}</summary>`); i++; continue; }
    if (t === '</details>') { flush(); out.push('</details>'); i++; continue; }

    if (t.startsWith('|') && i + 1 < lines.length && /^\|\s*:?-{3,}/.test(lines[i + 1]!.trim())) {
      flush();
      const head = splitRow(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(splitRow(lines[i++]!));
      const cell = (c: string) => (SEVERITY.has(c) ? `<span class="sev sev-${c.toLowerCase()}">${c}</span>` : inlineMd(c));
      out.push(
        `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    if (t.startsWith('>')) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) q.push(lines[i++]!.trim().replace(/^>\s?/, ''));
      out.push(`<blockquote>${q.map(inlineMd).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      flush();
      const ordered = /^\d+\./.test(t);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\.\s+/ : /^[-*]\s+/).test(lines[i]!.trim())) {
        const body = lines[i++]!.trim().replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, '');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
        items.push(
          task
            ? `<li class="task"><label><input type="checkbox"${task[1] === ' ' ? '' : ' checked'}> <span>${inlineMd(task[2]!)}</span></label></li>`
            : `<li>${inlineMd(body)}</li>`,
        );
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    para.push(t);
    i++;
  }
  flush();
  return out.join('\n');
}

/** Split on headings of one level, ignoring anything inside a code fence. */
function splitByHeading(lines: string[], level: number): { pre: string[]; parts: { title: string; lines: string[] }[] } {
  const mark = '#'.repeat(level) + ' ';
  const pre: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith(mark)) parts.push({ title: line.slice(mark.length).trim(), lines: [] });
    else (parts.length ? parts[parts.length - 1]!.lines : pre).push(line);
  }
  return { pre, parts };
}

/** The first `| Field | Value |` table of a block, as a lookup. */
function fieldTable(lines: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#')) break;
    if (!t.startsWith('|')) continue;
    const c = splitRow(t);
    if (c.length >= 2 && !/^:?-{3,}/.test(c[0]!)) f[c[0]!.toLowerCase()] = c[1]!.replace(/\\\|/g, '|');
  }
  return f;
}

function firstQuoteAfter(lines: string[], label: string): string {
  const at = lines.findIndex((l) => l.trim() === label);
  if (at < 0) return '';
  const q: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('>')) q.push(t.replace(/^>\s?/, ''));
    else if (q.length) break;
  }
  return q.join(' ');
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

function countChecks(section: string[] | undefined): BriefSummary['checks'] {
  const c = { error: 0, warn: 0, info: 0 };
  for (const line of section ?? []) {
    const first = line.trim().startsWith('|') ? splitRow(line)[0] : '';
    if (first === 'ERROR') c.error++;
    else if (first === 'WARN') c.warn++;
    else if (first === 'INFO') c.info++;
  }
  return c;
}

export function summarizeBrief(markdown: string): BriefSummary {
  const { meta, body } = parseFrontMatter(markdown.replace(/\r\n/g, '\n'));
  const { pre, parts } = splitByHeading(body.split('\n'), 2);
  const h1 = pre.find((l) => l.startsWith('# '));
  const hook = pre.filter((l) => l.trim().startsWith('>')).map((l) => l.trim().replace(/^>\s?/, '')).join(' ');
  const scenes = parts.find((p) => p.title === 'Scenes');
  return {
    title: meta.title || (h1 ? h1.slice(2).trim() : 'Untitled brief'),
    hook,
    meta,
    checks: countChecks(parts.find((p) => p.title === 'Quality checks')?.lines),
    sceneCount: scenes ? splitByHeading(scenes.lines, 3).parts.length : Number(meta.scene_count) || 0,
  };
}

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function statTiles(s: BriefSummary): string {
  const m = s.meta;
  const tiles: [string, string, string][] = [];
  const dur = Number(m.duration_sec);
  if (dur > 0) tiles.push(['Runtime', clock(dur), `${dur} s`]);
  tiles.push(['Scenes', String(s.sceneCount), m.aspect_ratio || '']);
  if (m.midroll_1) tiles.push(['Mid-rolls', [m.midroll_1, m.midroll_2].filter(Boolean).join(' · '), 'place by hand']);
  if (m.generation_complete) {
    const ok = m.generation_complete === 'true';
    tiles.push(['Script', ok ? 'Complete' : 'Incomplete', ok ? 'nothing degraded' : 'see the warning below']);
  }
  const { error, warn, info } = s.checks;
  tiles.push(['Checks', `${error} / ${warn} / ${info}`, 'errors / warnings / notes']);
  return tiles
    .map(([k, v, note], n) => {
      const bad = (k === 'Script' && v === 'Incomplete') || (k === 'Checks' && error > 0);
      return `<div class="tile${bad ? ' bad' : ''}" data-n="${n}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(note)}</div></div>`;
    })
    .join('');
}

// Sections that are reference material rather than something to read top to bottom start folded.
const FOLDED = new Set(['Style guide', 'Character bible', 'Narration (continuous read)', 'Shot list', 'Sound & edit', 'Publish package']);

function renderScene(part: { title: string; lines: string[] }, n: number): string {
  const { pre, parts } = splitByHeading(part.lines, 4);
  const f = fieldTable(pre);
  const narration = firstQuoteAfter(pre, '**Narration**');
  const m = /^Scene\s+(\d+)\s*[—-]\s*(.*)$/.exec(part.title);
  const num = m ? m[1]! : String(n + 1);
  const name = m ? m[2]! : part.title;
  const voice = (f['voice'] || 'Narrator').toLowerCase();
  const chips = [f['act phase'], f['duration'], f['voice'], f['visual type']]
    .filter(Boolean)
    .map((c, k) => `<span class="chip${k === 2 && voice.startsWith('analyst') ? ' accent' : ''}">${esc(c!)}</span>`)
    .join('');
  const search = esc(`${num} ${name} ${narration} ${f['act phase'] || ''} ${f['on-screen text'] || ''}`.toLowerCase());
  return (
    `<details class="scene" id="scene-${esc(num)}" data-voice="${voice.startsWith('analyst') ? 'analyst' : 'narrator'}" data-text="${search}">` +
    `<summary><span class="num">${esc(num)}</span><span class="st"><span class="name">${esc(name)}</span>` +
    `<span class="line">${esc(narration)}</span></span><span class="chips">${chips}</span></summary>` +
    `<div class="body">${mdToHtml(pre)}` +
    parts.map((p) => `<details class="sub"><summary>${esc(p.title)}</summary>${mdToHtml(p.lines)}</details>`).join('') +
    '</div></details>'
  );
}

const CSS = `
:root{--ground:#141310;--surface:#1e1c18;--rule:#332f28;--ink:#ece9e2;--dim:#b8b3a8;--mute:#8b8578;--ember:#e0602a;--ember-d:#c84b11;--ok:#7fb069;--bad:#d9634a;--warn:#d9a441}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:64px}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:var(--ember)}code,pre{font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;font-size:12.5px}
code{background:var(--rule);padding:1px 5px;border-radius:4px}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px 80px}
header.top{padding:32px 0 8px}
.brand{font:600 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ember)}
.brand a{color:var(--mute);text-decoration:none;margin-left:12px}
h1{font:400 34px/1.15 'DM Serif Display',Georgia,serif;margin:10px 0 8px}
.hook{color:var(--dim);max-width:70ch;margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:8px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:12px 14px}
.tile .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.tile .v{font-size:22px;font-weight:600;margin-top:2px}.tile .n{font-size:12px;color:var(--mute)}
.tile.bad{border-color:var(--bad)}.tile.bad .v{color:var(--bad)}
nav.jump{position:sticky;top:0;z-index:5;background:var(--ground);border-bottom:1px solid var(--rule);display:flex;gap:6px;overflow-x:auto;padding:10px 0;margin-bottom:16px}
nav.jump a{white-space:nowrap;color:var(--dim);text-decoration:none;font-size:13px;padding:5px 10px;border:1px solid var(--rule);border-radius:999px}
nav.jump a:hover{color:var(--ink);border-color:var(--ember)}
details.sec{background:var(--surface);border:1px solid var(--rule);border-radius:12px;margin:12px 0}
details.sec>summary{cursor:pointer;padding:14px 18px;font-size:17px;font-weight:600;list-style:none}
details.sec>summary::-webkit-details-marker,details.scene>summary::-webkit-details-marker{display:none}
details.sec>summary::before,details.sub>summary::before{content:'+';display:inline-block;width:18px;color:var(--ember);font-family:monospace}
details.sec[open]>summary::before,details.sub[open]>summary::before{content:'\\2212'}
details.sec>.body{padding:0 18px 16px}
h3{font-size:16px;margin:22px 0 8px}h4,h5,h6{font-size:14px;margin:18px 0 6px;color:var(--dim)}
p{margin:8px 0}em{color:var(--dim)}
blockquote{margin:10px 0;padding:10px 14px;border-left:3px solid var(--ember-d);background:var(--ground);border-radius:0 8px 8px 0}
.tbl{overflow-x:auto;margin:10px 0}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--rule)}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);font-weight:600}
.sev{font:600 11px/1 monospace;padding:3px 7px;border-radius:4px;border:1px solid}
.sev-error{color:var(--bad)}.sev-warn{color:var(--warn)}.sev-info{color:var(--mute)}
.code{position:relative;margin:6px 0 12px}
.code pre{margin:0;background:var(--ground);border:1px solid var(--rule);border-radius:8px;padding:12px 70px 12px 12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
button{font:inherit;cursor:pointer;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:5px 10px;font-size:12px}
button:hover{border-color:var(--ember)}button.copy{position:absolute;top:8px;right:8px}button.done{color:var(--ok);border-color:var(--ok)}
ul,ol{padding-left:22px}li.task{list-style:none;margin-left:-22px}li.task label{display:flex;gap:10px;align-items:flex-start;padding:6px 0;cursor:pointer}
li.task input{margin-top:4px;accent-color:var(--ember-d)}li.task input:checked+span{color:var(--mute);text-decoration:line-through}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 12px}
.bar input[type=search]{flex:1;min-width:200px;background:var(--ground);border:1px solid var(--rule);border-radius:8px;color:var(--ink);padding:8px 12px;font:inherit}
.bar button.on{border-color:var(--ember);color:var(--ember)}.bar .count{color:var(--mute);font-size:12px}
details.scene{border:1px solid var(--rule);border-radius:10px;margin:6px 0;background:var(--ground)}
details.scene>summary{cursor:pointer;list-style:none;display:flex;gap:12px;align-items:center;padding:10px 12px}
details.scene[open]>summary{border-bottom:1px solid var(--rule)}
.num{flex:none;width:34px;height:34px;border-radius:8px;background:var(--surface);border:1px solid var(--rule);display:grid;place-items:center;font:600 13px monospace;color:var(--ember)}
.st{flex:1;min-width:0;display:flex;flex-direction:column}.name{font-weight:600}
.line{color:var(--mute);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chips{flex:none;display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:45%}
.chip{font-size:11px;padding:2px 8px;border:1px solid var(--rule);border-radius:999px;color:var(--dim);white-space:nowrap}
.chip.accent{color:var(--ember);border-color:var(--ember-d)}
details.scene>.body{padding:6px 14px 14px}
details.sub{border-top:1px solid var(--rule);margin-top:10px;padding-top:8px}details.sub>summary{cursor:pointer;font-weight:600;color:var(--dim);list-style:none}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:20px}
a.card{display:block;text-decoration:none;color:inherit;background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:16px}
a.card:hover{border-color:var(--ember)}a.card h2{font:400 20px/1.25 'DM Serif Display',Georgia,serif;margin:6px 0 8px}
a.card .d{font:11px monospace;color:var(--mute)}a.card .m{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
footer{color:var(--mute);font-size:12px;margin-top:28px}
@media(max-width:640px){h1{font-size:26px}.chips{display:none}}
@media print{nav.jump,.bar,button{display:none}details.sec,details.scene{break-inside:avoid}}
`;

// Static. Nothing from the brief is ever interpolated into this script.
const JS = `
(function(){
  var key='brief:'+document.body.dataset.file;
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('button.copy');if(!b)return;
    var text=b.parentNode.querySelector('pre').textContent;
    var ok=function(){b.textContent='Copied';b.classList.add('done');setTimeout(function(){b.textContent='Copy';b.classList.remove('done')},1400)};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok,fallback)}else fallback();
    function fallback(){var t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();try{document.execCommand('copy');ok()}catch(_){}t.remove()}
  });
  var boxes=[].slice.call(document.querySelectorAll('li.task input'));var saved={};
  try{saved=JSON.parse(localStorage.getItem(key)||'{}')}catch(_){}
  boxes.forEach(function(c,i){if(saved[i]!==undefined)c.checked=!!saved[i];c.addEventListener('change',function(){saved[i]=c.checked;try{localStorage.setItem(key,JSON.stringify(saved))}catch(_){}})});
  var scenes=[].slice.call(document.querySelectorAll('details.scene'));var q=document.getElementById('q');var voice='all';var count=document.getElementById('count');
  function apply(){var t=(q&&q.value||'').toLowerCase().trim();var n=0;
    scenes.forEach(function(s){var show=(voice==='all'||s.dataset.voice===voice)&&(!t||s.dataset.text.indexOf(t)>=0);s.hidden=!show;if(show)n++});
    if(count)count.textContent=n+' of '+scenes.length+' scenes'}
  if(q)q.addEventListener('input',apply);
  [].forEach.call(document.querySelectorAll('[data-voice-filter]'),function(b){b.addEventListener('click',function(){voice=b.dataset.voiceFilter;
    [].forEach.call(document.querySelectorAll('[data-voice-filter]'),function(x){x.classList.toggle('on',x===b)});apply()})});
  [].forEach.call(document.querySelectorAll('[data-all]'),function(b){b.addEventListener('click',function(){var open=b.dataset.all==='open';scenes.forEach(function(s){if(!s.hidden)s.open=open})})});
  function reveal(){var el=location.hash&&document.getElementById(location.hash.slice(1));while(el){if(el.tagName==='DETAILS')el.open=true;el=el.parentElement}}
  window.addEventListener('hashchange',reveal);reveal();apply();
})();
`;

function page(title: string, file: string, inner: string): string {
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">` +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body data-file="${esc(file)}"><div class="wrap">${inner}</div><script>${JS}</script></body></html>\n`
  );
}

/**
 * One brief as a page. `indexHref` is where "All briefs" points ('' hides the link).
 */
export function renderBriefPage(markdown: string, fileName: string, indexHref = 'index.html'): string {
  const md = markdown.replace(/\r\n/g, '\n');
  const summary = summarizeBrief(md);
  const { body } = parseFrontMatter(md);
  const { pre, parts } = splitByHeading(body.split('\n'), 2);

  // Anything between the title/hook and the first section is a warning banner the exporter put there on purpose.
  const lead = pre.filter((l) => !l.startsWith('# '));
  const hookEnd = lead.findIndex((l, i) => l.trim().startsWith('>') && !(lead[i + 1] ?? '').trim().startsWith('>'));
  const banners = mdToHtml(summary.hook ? lead.slice(hookEnd + 1) : lead);

  const ids = new Map<string, number>();
  const sections = parts.map((p) => {
    const base = slug(p.title);
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    return { ...p, id: n > 1 ? `${base}-${n}` : base };
  });

  const nav = sections.map((s) => `<a href="#${s.id}">${esc(s.title.replace(/\s*\(.*\)$/, ''))}</a>`).join('');
  const html = sections
    .map((s) => {
      let inner: string;
      if (s.title === 'Scenes') {
        const split = splitByHeading(s.lines, 3);
        inner =
          mdToHtml(split.pre) +
          '<div class="bar"><input type="search" id="q" placeholder="Filter scenes by title, narration or act" aria-label="Filter scenes">' +
          '<button type="button" class="on" data-voice-filter="all">All</button>' +
          '<button type="button" data-voice-filter="narrator">Narrator</button>' +
          '<button type="button" data-voice-filter="analyst">Analyst</button>' +
          '<button type="button" data-all="open">Expand all</button><button type="button" data-all="close">Collapse all</button>' +
          '<span class="count" id="count"></span></div>' +
          split.parts.map(renderScene).join('\n');
      } else inner = mdToHtml(s.lines);
      return `<details class="sec" id="${s.id}"${FOLDED.has(s.title) ? '' : ' open'}><summary>${esc(s.title)}</summary><div class="body">${inner}</div></details>`;
    })
    .join('\n');

  const m = summary.meta;
  const inner =
    `<header class="top"><div class="brand">${esc(m.channel || 'Brief')}${indexHref ? `<a href="${esc(indexHref)}">All briefs</a>` : ''}</div>` +
    `<h1>${esc(summary.title)}</h1>${summary.hook ? `<p class="hook">${inlineMd(summary.hook)}</p>` : ''}` +
    `<div class="tiles">${statTiles(summary)}</div>${banners}</header>` +
    `<nav class="jump">${nav}</nav>${html}` +
    `<footer>${esc(fileName)}${m.generated ? ` · generated ${esc(m.generated)}` : ''} · a view of the exported brief; the Markdown file is the source.</footer>`;
  return page(summary.title, fileName, inner);
}

export interface BriefIndexItem { href: string; fileName: string; modified: string; bytes: number; summary: BriefSummary }

/** The list of every exported brief, newest first. */
export function renderBriefIndex(items: BriefIndexItem[]): string {
  const cards = [...items]
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .map(({ href, fileName, modified, bytes, summary: s }) => {
      const dur = Number(s.meta.duration_sec);
      const chips = [
        dur > 0 ? clock(dur) : '',
        `${s.sceneCount} scenes`,
        s.meta.generation_complete === 'false' ? 'incomplete' : '',
        s.checks.error ? `${s.checks.error} errors` : '',
        s.checks.warn ? `${s.checks.warn} warnings` : '',
        `${Math.round(bytes / 1024)} KB`,
      ].filter(Boolean);
      return (
        `<a class="card" href="${esc(href)}"><div class="d">${esc(modified.slice(0, 10))} · ${esc(fileName)}</div>` +
        `<h2>${esc(s.title)}</h2><div class="hook">${esc(s.hook.slice(0, 180))}</div>` +
        `<div class="m">${chips.map((c) => `<span class="chip${/error|incomplete/.test(c) ? ' accent' : ''}">${esc(c)}</span>`).join('')}</div></a>`
      );
    })
    .join('');
  const inner =
    `<header class="top"><div class="brand">Briefs</div><h1>Exported briefs</h1>` +
    `<p class="hook">${items.length} brief${items.length === 1 ? '' : 's'} in exports/, newest first.</p></header>` +
    `<div class="cards">${cards || '<p>No briefs exported yet.</p>'}</div>`;
  return page('Exported briefs', 'index', inner);
}

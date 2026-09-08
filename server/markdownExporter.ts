import fs from 'fs/promises';
import path from 'path';

/**
 * Renders a finished script to a production-ready Markdown brief and writes it
 * into exports/. The file is the deliverable: everything needed to shoot,
 * generate or commission the video, with no need to open the app again.
 */

export const EXPORTS_DIR = path.resolve(process.cwd(), 'exports');

function slugify(input: string): string {
  return (input || 'untitled')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function fence(body: string, lang = ''): string {
  return '```' + lang + '\n' + body.trim() + '\n```';
}

function table(headers: string[], rows: string[][]): string {
  const esc = (c: string) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function renderScriptMarkdown(payload: {
  script: any;
  research?: any;
  plan?: any;
  channelBrandName?: string;
}): string {
  const { script, research, plan, channelBrandName } = payload;
  const s = script || {};
  const scenes: any[] = Array.isArray(s.scenes) ? s.scenes : [];
  const out: string[] = [];

  const generatedAt = new Date().toISOString();

  // ---- Front matter, so these files stay machine-readable too ----
  out.push('---');
  out.push(`title: ${JSON.stringify(s.title || research?.topicTitle || 'Untitled Script')}`);
  out.push(`generated: ${generatedAt}`);
  out.push(`platform: ${JSON.stringify(s.targetPlatform || '')}`);
  out.push(`aspect_ratio: ${JSON.stringify(s.aspectRatio || '')}`);
  out.push(`duration_sec: ${s.estimatedTotalDuration ?? ''}`);
  out.push(`scene_count: ${scenes.length}`);
  if (channelBrandName) out.push(`channel: ${JSON.stringify(channelBrandName)}`);
  out.push('---');
  out.push('');

  out.push(`# ${s.title || 'Untitled Script'}`);
  out.push('');
  if (research?.oneLineHook) out.push(`> ${research.oneLineHook}`);
  out.push('');

  // ---- Production header ----
  const meta: string[][] = [
    ['Platform', s.targetPlatform || '—'],
    ['Aspect ratio', s.aspectRatio || '—'],
    ['Total duration', s.estimatedTotalDuration ? `~${s.estimatedTotalDuration}s` : '—'],
    ['Scenes', String(scenes.length)],
    ['Word count', String(s.totalWordCount ?? scenes.reduce((n, x) => n + (x.wordCount || (x.narration || '').split(/\s+/).filter(Boolean).length), 0))],
    ['Target WPM', String(s.targetWpm ?? '—')],
    ['Tone / pacing', s.tonePacing || plan?.tone || '—'],
    ['Virality score', s.viralityScore != null ? String(s.viralityScore) : '—'],
  ];
  out.push('## Production summary');
  out.push('');
  out.push(table(['Field', 'Value'], meta));
  out.push('');

  // ---- Sources, stated up front so claims are checkable ----
  const retrieved: any[] = research?.retrievedSources || [];
  if (retrieved.length) {
    out.push('## Sources');
    out.push('');
    out.push(
      table(
        ['ID', 'Title', 'URL', 'Status'],
        retrieved.map((r) => [
          r.id,
          r.title || '—',
          r.url,
          r.ok ? `read (${r.wordCount} words)` : `NOT READ — ${r.error || 'unavailable'}`,
        ])
      )
    );
    out.push('');
    const failed = retrieved.filter((r) => !r.ok);
    if (failed.length) {
      out.push(
        `> **${failed.length} source(s) could not be retrieved.** Claims that would have depended on them are unverified — check before publishing.`
      );
      out.push('');
    }
  } else {
    out.push('## Sources');
    out.push('');
    out.push('> **No sources were retrieved for this script.** Every factual claim below is unverified model output. Do not publish without checking.');
    out.push('');
  }

  if (research?.factCitations?.length) {
    out.push('### Fact attribution');
    out.push('');
    out.push(
      table(
        ['Claim', 'Sources'],
        research.factCitations.map((f: any) => [f.fact, (f.sourceIds || []).join(', ') || '—'])
      )
    );
    out.push('');
  }

  // ---- Style guide ----
  if (s.styleGuide) {
    const g = s.styleGuide;
    out.push('## Style guide');
    out.push('');
    out.push('Applies to every scene. Keep it identical across shots or the set stops matching.');
    out.push('');
    out.push(
      table(
        ['Aspect', 'Direction'],
        [
          ['Art direction', g.artDirection || '—'],
          ['Colour palette', g.colorPalette || '—'],
          ['Lighting', g.lighting || '—'],
          ['Lens / film', g.lensAndFilm || '—'],
          ['Negative prompt', g.negativePrompt || '—'],
        ]
      )
    );
    out.push('');
  }

  // ---- Character bible ----
  const bible: any[] = s.characterBible || [];
  if (bible.length) {
    out.push('## Character bible');
    out.push('');
    out.push('Paste each `promptAnchor` **verbatim** into every image prompt featuring that character. Rewording it is what makes a character drift between scenes.');
    out.push('');
    for (const c of bible) {
      out.push(`### ${c.name}${c.role ? ` — ${c.role}` : ''}`);
      out.push('');
      out.push(
        table(
          ['Attribute', 'Detail'],
          [
            ['ID', `\`${c.id}\``],
            ['Appearance', c.appearance || '—'],
            ['Wardrobe', c.wardrobe || '—'],
            ['Palette', c.palette || '—'],
            ['Expression range', c.expressionRange || '—'],
          ]
        )
      );
      out.push('');
      out.push('**Prompt anchor — copy exactly:**');
      out.push('');
      out.push(fence(c.promptAnchor || '', 'text'));
      out.push('');
    }
  }

  // ---- Narration teleprompter ----
  out.push('## Narration (continuous read)');
  out.push('');
  if (s.signatureIntro) out.push(`_${s.signatureIntro}_`);
  out.push('');
  out.push(scenes.map((sc) => (sc.narration || '').trim()).filter(Boolean).join('\n\n'));
  out.push('');
  if (s.signatureOutro) out.push(`_${s.signatureOutro}_`);
  out.push('');

  // ---- Shot list ----
  if (scenes.length) {
    out.push('## Shot list');
    out.push('');
    out.push(
      table(
        ['#', 'Scene', 'Dur', 'Shot', 'Camera', 'Transition', 'Sources'],
        scenes.map((sc) => [
          String(sc.sceneNumber ?? ''),
          sc.title || '',
          sc.durationEst ? `${sc.durationEst}s` : '—',
          sc.motion?.shotType || '—',
          sc.motion?.cameraMove || '—',
          sc.motion?.transitionOut || '—',
          (sc.citations || []).join(', ') || '—',
        ])
      )
    );
    out.push('');
  }

  // ---- Per-scene detail ----
  out.push('---');
  out.push('');
  out.push('## Scenes');
  out.push('');

  for (const sc of scenes) {
    out.push(`### Scene ${sc.sceneNumber ?? '?'} — ${sc.title || 'Untitled'}`);
    out.push('');
    const head: string[][] = [
      ['Act phase', sc.actPhase || '—'],
      ['Duration', sc.durationEst ? `${sc.durationEst}s` : '—'],
      ['Visual type', sc.visualType || '—'],
      ['On-screen text', sc.onScreenText || '—'],
      ['Sound', sc.soundEffect || '—'],
      ['Citations', (sc.citations || []).join(', ') || '—'],
    ];
    out.push(table(['Field', 'Value'], head));
    out.push('');

    out.push('**Narration**');
    out.push('');
    out.push('> ' + (sc.narration || '').trim().replace(/\n/g, '\n> '));
    out.push('');

    if (sc.cinematography) {
      out.push(`**Cinematography** — ${sc.cinematography}`);
      out.push('');
    }

    // Layered image prompts
    const v = sc.visual;
    if (v) {
      out.push('#### Image prompts');
      out.push('');
      out.push('**Character layer**');
      out.push(fence(v.character || 'No characters in frame.', 'text'));
      out.push('');
      out.push('**Background layer**');
      out.push(fence(v.background || '', 'text'));
      out.push('');
      out.push('**Composed scene**');
      out.push(fence(v.scene || '', 'text'));
      out.push('');
      out.push('**Style anchor** (identical across all scenes)');
      out.push(fence(v.styleAnchor || '', 'text'));
      out.push('');
      if (v.negative) {
        out.push('**Negative prompt**');
        out.push(fence(v.negative, 'text'));
        out.push('');
      }
      out.push('<details><summary>Full flat prompt (character + background + scene + style)</summary>');
      out.push('');
      out.push(fence([v.character, v.background, v.scene, v.styleAnchor].filter(Boolean).join('\n\n'), 'text'));
      out.push('');
      out.push('</details>');
      out.push('');
    } else if (sc.visualPrompt) {
      out.push('#### Image prompt');
      out.push(fence(sc.visualPrompt, 'text'));
      out.push('');
    }

    // Motion
    const m = sc.motion;
    if (m) {
      out.push('#### Motion / animation');
      out.push('');
      out.push(
        table(
          ['Parameter', 'Value'],
          [
            ['Shot type', m.shotType || '—'],
            ['Camera move', m.cameraMove || '—'],
            ['Subject motion', m.subjectMotion || '—'],
            ['Duration', m.durationSec ? `${m.durationSec}s` : '—'],
            ['Easing', m.easing || '—'],
            ['Transition out', m.transitionOut || '—'],
          ]
        )
      );
      out.push('');
      if (m.motionPrompt) {
        out.push('**Motion prompt — paste into an image-to-video model:**');
        out.push(fence(m.motionPrompt, 'text'));
        out.push('');
      }
    }

    // Infographic
    if (sc.infographic) {
      const g = sc.infographic;
      out.push('#### Infographic overlay');
      out.push('');
      out.push(`**${g.title || ''}**${g.badge ? ` — \`${g.badge}\`` : ''}`);
      out.push('');
      if (g.summary) {
        out.push(g.summary);
        out.push('');
      }
      if (g.steps?.length) {
        out.push(table(['Step', 'Detail', 'Status'], g.steps.map((x: any) => [x.label, x.detail, x.status])));
        out.push('');
      }
      if (g.metrics?.length) {
        out.push(table(['Metric', 'Value', 'Note'], g.metrics.map((x: any) => [x.label, x.value, x.subtext || '—'])));
        out.push('');
      }
      if (g.codeSnippet?.lines?.length) {
        out.push(
          fence(
            g.codeSnippet.lines.map((l: any) => l.text).join('\n'),
            g.codeSnippet.language || 'bash'
          )
        );
        out.push('');
      }
      if (g.commentQuote) {
        out.push(`> "${g.commentQuote.comment}"`);
        out.push('>');
        out.push(`> — **${g.commentQuote.author}** (${g.commentQuote.karma} karma, ${g.commentQuote.vibe})`);
        out.push('');
      }
    }

    if (sc.retentionNote) {
      out.push(`**Retention note** — ${sc.retentionNote}`);
      out.push('');
    }
    out.push('---');
    out.push('');
  }

  // ---- Appendix ----
  if (plan || research) {
    out.push('## Appendix');
    out.push('');
    if (plan?.narrativeBeats?.length) {
      out.push('### Narrative beats');
      out.push('');
      out.push(
        table(
          ['Act', 'Purpose', 'Dur', 'Visual tone', 'Takeaway'],
          plan.narrativeBeats.map((b: any) => [b.act, b.purpose, `${b.durationSec}s`, b.visualTone, b.keyTakeaway])
        )
      );
      out.push('');
    }
    if (research?.keyFacts?.length) {
      out.push('### Key facts');
      out.push('');
      out.push(research.keyFacts.map((f: string) => `- ${f}`).join('\n'));
      out.push('');
    }
    if (research?.timeline?.length) {
      out.push('### Timeline');
      out.push('');
      out.push(table(['Phase', 'Event'], research.timeline.map((t: any) => [t.dateOrPhase, t.event])));
      out.push('');
    }
  }

  out.push(`_Generated by ContentPipe on ${generatedAt}_`);
  out.push('');

  return out.join('\n');
}

export async function writeScriptMarkdown(payload: {
  script: any;
  research?: any;
  plan?: any;
  channelBrandName?: string;
}): Promise<{ filename: string; absolutePath: string; relativePath: string; bytes: number }> {
  const markdown = renderScriptMarkdown(payload);
  await fs.mkdir(EXPORTS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${slugify(payload.script?.title || payload.research?.topicTitle || 'script')}`;

  // Never clobber an earlier export of the same story on the same day.
  let filename = `${base}.md`;
  let n = 2;
  while (true) {
    try {
      await fs.access(path.join(EXPORTS_DIR, filename));
      filename = `${base}-${n++}.md`;
    } catch {
      break;
    }
  }

  const absolutePath = path.join(EXPORTS_DIR, filename);
  await fs.writeFile(absolutePath, markdown, 'utf8');

  return {
    filename,
    absolutePath,
    relativePath: path.join('exports', filename),
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };
}

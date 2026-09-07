/**
 * Concise markdown / JSON reports for the conformance lab.
 */

function line(flag) {
  const tag =
    flag.severity === 'defect' ? 'FAIL' : flag.severity === 'browser' ? 'BROWSER' : 'NOTE';
  return `- **${tag}** \`${flag.kind}\` — ${flag.message}`;
}

function group(flags, severity) {
  return flags.filter((f) => f.severity === severity);
}

/**
 * @param {object} comparison  result of `compareMeasurements` / a merged report
 * @param {object} [meta]
 */
export function renderMarkdown(comparison, meta = {}) {
  const flags = comparison.flags ?? [];
  const summary = comparison.summary ?? {};
  const defects = group(flags, 'defect');
  const browsers = group(flags, 'browser');
  const notes = group(flags, 'info');
  const lines = [];
  lines.push('# Sonic regression report');
  lines.push('');
  if (meta.baseline) lines.push(`- **Baseline:** ${meta.baseline}`);
  if (meta.candidate) lines.push(`- **Candidate:** ${meta.candidate}`);
  if (meta.generatedAt) lines.push(`- **Generated:** ${meta.generatedAt}`);
  lines.push(`- **Pairs:** ${summary.pairCount ?? '—'}`);
  lines.push(`- **Defects:** ${defects.length}`);
  lines.push(`- **Browser notes:** ${browsers.length}`);
  lines.push(`- **Creative / informational:** ${notes.length}`);
  lines.push(`- **Result:** ${summary.ok === false || defects.length ? 'FAIL' : 'PASS'}`);
  lines.push('');
  lines.push('REFERENCE / CLEAN flags are defects. CREATIVE / SIGNAL ROT flags are notes');
  lines.push('unless they are NaN, true-peak violations, unexpected DC, or missing channels.');
  lines.push('');

  const section = (title, items, empty) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!items.length) {
      lines.push(empty);
      lines.push('');
      return;
    }
    for (const f of items) lines.push(line(f));
    lines.push('');
  };

  section('Defects', defects, '_None._');
  section('Cross-browser divergence', browsers, '_None recorded._');
  section('Creative / informational', notes, '_None._');

  if (comparison.findings?.length) {
    lines.push('## Findings for Agent A');
    lines.push('');
    for (const f of comparison.findings) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (comparison.performance) {
    lines.push('## Performance');
    lines.push('');
    lines.push('```');
    lines.push(JSON.stringify(comparison.performance, null, 2));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function renderJson(comparison, meta = {}) {
  return {
    meta: {
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
      baseline: meta.baseline ?? null,
      candidate: meta.candidate ?? null,
      ...meta,
    },
    summary: comparison.summary,
    flags: comparison.flags,
    pairs: (comparison.pairs ?? []).map((p) => ({
      id: p.id,
      class: p.class,
      deltas: p.deltas,
    })),
    findings: comparison.findings ?? [],
    performance: comparison.performance ?? null,
  };
}

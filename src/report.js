/**
 * Machine- and human-readable report serializers.
 *
 * Every format is derived from the same report object. The score fields are the
 * two triage scores: blockingScore (PDF/UA-critical/serious) and polishScore
 * (quality), plus a status. summary.score is kept as an alias of blockingScore
 * for backwards compatibility.
 */
import { RULES, MANUAL_CHECKS } from '../rules/catalog.js';

export function toJson(report) {
  return JSON.stringify(report, null, 2);
}

function mdCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function fenceFor(value) {
  const longest = Math.max(0, ...(String(value).match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  // Spreadsheet programs interpret these leading characters as formulas.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function standardsLine(standards) {
  return (standards || []).map((item) => `${item.name} ${item.ref}`).join(' · ');
}

const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor', 'advisory'];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function scoreLine(report) {
  const summary = report.summary || {};
  return `${String(summary.status || 'review').toUpperCase()} · blocking ${summary.blockingScore}/100 · polish ${summary.polishScore}/100 · ${summary.findings} finding${summary.findings === 1 ? '' : 's'} (${summary.occurrences} occurrence${summary.occurrences === 1 ? '' : 's'})`;
}

/** Distinct rules ordered by impact, used by every "fix first" surface. */
export function topFixRules(report, limit = 5) {
  const tierRank = { blocking: 0, polish: 1, info: 2 };
  const seen = new Map();
  for (const finding of report.findings || []) {
    const existing = seen.get(finding.ruleId);
    if (existing) { existing.occurrences += finding.occurrences || 1; continue; }
    seen.set(finding.ruleId, { ...finding, occurrences: finding.occurrences || 1 });
  }
  return [...seen.values()]
    .sort((a, b) => {
      const tier = (tierRank[a.tier] ?? 2) - (tierRank[b.tier] ?? 2);
      if (tier) return tier;
      const severity = severityRank(a.severity) - severityRank(b.severity);
      if (severity) return severity;
      return (b.occurrences || 1) - (a.occurrences || 1);
    })
    .slice(0, limit);
}

function pagesLabel(finding) {
  const pages = finding.evidence && Array.isArray(finding.evidence.pages) ? finding.evidence.pages : [];
  if (!pages.length) return finding.page ? `page ${finding.page}` : '';
  if (pages.length === 1) return `page ${pages[0]}`;
  const shown = pages.slice(0, 8).join(', ');
  return `${pages.length} pages (${shown}${pages.length > 8 ? ', …' : ''})`;
}

/**
 * Compact triage summary: counts, per-rule rollup, top fixes. Designed to stay
 * small enough to return from an MCP tool without flooding an agent context.
 */
export function toSummary(report) {
  const summary = report.summary || {};
  const doc = report.document || {};
  const lines = [];
  lines.push(`# PDF accessibility audit — ${report.file.name}`);
  lines.push('');
  lines.push(`**Status:** ${String(summary.status || 'review').toUpperCase()} · **Blocking score:** ${summary.blockingScore}/100 · **Polish score:** ${summary.polishScore}/100`);
  lines.push(`**Findings:** ${summary.findings} (${summary.occurrences} occurrences) · **Pages:** ${doc.pageCount} · **Tagged:** ${doc.tagged ? 'yes' : 'no'}${doc.language ? ` · **Language:** ${doc.language}` : ' · **Language:** missing'}${doc.pagesScanned ? ` · **Scanned pages:** ${doc.pagesScanned}` : ''}`);
  lines.push('');
  const byTier = { blocking: [], polish: [], info: [] };
  for (const finding of report.findings || []) {
    const tier = finding.tier || (finding.severity === 'critical' || finding.severity === 'serious' ? 'blocking' : 'polish');
    (byTier[tier] || byTier.info).push(finding);
  }
  const rollup = (label, findings) => {
    if (!findings.length) return;
    lines.push(`## ${label}`);
    for (const finding of findings) {
      const where = pagesLabel(finding);
      lines.push(`- \`${finding.ruleId}\` (${finding.severity}, ${finding.occurrences}×)${where ? ` — ${where}` : ''}`);
    }
    lines.push('');
  };
  rollup('Blocking findings (PDF/UA)', byTier.blocking);
  rollup('Polish findings (quality)', byTier.polish);
  if (byTier.info.length) rollup('Information only (not scored)', byTier.info);
  if (!(report.findings || []).length) {
    lines.push('No automated findings. This is not a conformance certificate: complete the manual checks.');
    lines.push('');
  }
  const checks = report.checks || [];
  lines.push(`**Checks:** ${checks.length} total · ${checks.filter((check) => check.status === 'pass').length} passed · ${checks.filter((check) => check.status === 'fail').length} failed · ${checks.filter((check) => check.status === 'skipped').length} skipped`);
  lines.push(`**Manual review:** ${(report.manualChecks || MANUAL_CHECKS).length} checks must be completed before any conformance claim.`);
  lines.push('');
  lines.push('_Triage report, not a PDF/UA conformance certificate. A blocking score does not mean the document is accessible; use veraPDF or PAC plus a screen reader for conformance. Full evidence: JSON (`--format json`) or HTML (`--format html`)._');
  return lines.join('\n');
}

export function toMarkdown(report) {
  const summary = report.summary || {};
  const doc = report.document || {};
  const lines = [];
  lines.push(`# PDF accessibility audit — ${report.file.name}`);
  lines.push('');
  lines.push(`**Status:** ${String(summary.status || 'review').toUpperCase()} · **Blocking score:** ${summary.blockingScore}/100 · **Polish score:** ${summary.polishScore}/100`);
  lines.push(`**Findings:** ${summary.findings} (${summary.occurrences} occurrences) · Generated ${report.generatedAt} by ${report.tool} ${report.version} · score model ${report.scoreModel || 'triage-2'}`);
  lines.push('');
  lines.push('## How the scores work');
  lines.push('');
  lines.push('The blocking score starts at 100 and subtracts capped penalties for PDF/UA-critical and serious findings; the polish score does the same for moderate, minor and advisory findings. Each rule contributes at most its cap, grouped root causes are charged once, and page-level defects count once so a longer document is not punished twice. The scores are triage signals, not conformance scores.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Findings |');
  lines.push('|---|---:|');
  for (const severity of SEVERITY_ORDER) lines.push(`| ${severity[0].toUpperCase()}${severity.slice(1)} | ${summary[severity] || 0} |`);
  lines.push(`| **Total** | **${summary.findings}** (${summary.occurrences} occurrences) |`);
  lines.push('');
  lines.push('## Document');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| File | ${mdCell(report.file.name)} |`);
  lines.push(`| Pages | ${doc.pageCount} |`);
  lines.push(`| Title | ${mdCell(doc.title || 'Missing')} |`);
  lines.push(`| Language | ${mdCell(doc.language || 'Missing')} |`);
  lines.push(`| Tagged | ${doc.tagged ? 'Yes' : 'No'} |`);
  lines.push(`| Marked content | ${doc.marked ? 'Yes' : 'No'} |`);
  lines.push(`| PDF/UA claim | ${doc.pdfuaClaim ? 'Yes' : 'No'} |`);
  lines.push(`| Fonts | ${doc.fonts} |`);
  lines.push(`| Form fields | ${doc.formFields} |`);
  lines.push(`| Scanned pages | ${doc.pagesScanned} |`);
  lines.push('');
  const findings = report.findings || [];
  if (findings.length) {
    lines.push('## Findings by rule');
    lines.push('');
    lines.push('| Rule | Severity | Tier | Occurrences | Pages |');
    lines.push('|---|---|---|---:|---|');
    for (const finding of findings) {
      lines.push(`| \`${finding.ruleId}\` | ${finding.severity} | ${finding.tier || ''} | ${finding.occurrences || 1} | ${mdCell(pagesLabel(finding))} |`);
    }
    lines.push('');
    lines.push('## What to fix first');
    lines.push('');
    for (const finding of topFixRules(report)) {
      lines.push(`### ${finding.title}`);
      lines.push('');
      lines.push(`**Rule:** \`${finding.ruleId}\` · **Severity:** ${finding.severity} · **Occurrences:** ${finding.occurrences || 1}${pagesLabel(finding) ? ` · ${pagesLabel(finding)}` : ''}`);
      lines.push('');
      lines.push(`**Remediation:** ${finding.remediation}`);
      if (finding.standards && finding.standards.length) lines.push(`**Standards:** ${standardsLine(finding.standards)}`);
      lines.push('');
    }
    lines.push('## All findings');
    lines.push('');
    for (const finding of findings) {
      lines.push(`### ${finding.severity.toUpperCase()} · ${finding.title}`);
      lines.push('');
      if (finding.page) lines.push(`**Page:** ${finding.page}  `);
      if (finding.occurrences && finding.occurrences > 1) lines.push(`**Occurrences:** ${finding.occurrences}  `);
      lines.push(`**Rule:** \`${finding.ruleId}\`  `);
      lines.push(`**Standards:** ${standardsLine(finding.standards)}`);
      lines.push('');
      lines.push(finding.message);
      lines.push('');
      if (finding.evidence != null) {
        const fence = fenceFor(JSON.stringify(finding.evidence, null, 2));
        lines.push(`${fence}json`);
        lines.push(JSON.stringify(finding.evidence, null, 2));
        lines.push(fence);
        lines.push('');
      }
      lines.push(`**Remediation:** ${finding.remediation}`);
      lines.push('');
    }
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push('No automated findings. This is not a conformance certificate; complete the manual checks.');
    lines.push('');
  }
  lines.push('## Manual checks');
  lines.push('');
  for (const check of MANUAL_CHECKS) {
    lines.push(`- [ ] **${check.title}** — ${check.summary}  `);
    lines.push(`  ${check.guidance}`);
  }
  lines.push('');
  lines.push('## Automated checks');
  lines.push('');
  lines.push('| Check | Category | Tier | Status |');
  lines.push('|---|---|---|---|');
  for (const check of report.checks || []) {
    lines.push(`| ${mdCell(check.title)} | ${mdCell(check.category)} | ${mdCell(check.tier || '')} | ${check.status}${check.reason ? ` — ${mdCell(check.reason)}` : ''} |`);
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const limitation of report.limitations || []) lines.push(`- ${limitation}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`Generated locally by [pdf-a11y-audit](https://remediatepdf.com/open/pdf-a11y-audit) ${report.version}. No document was uploaded.`);
  lines.push('');
  return lines.join('\n');
}

const CSV_HEADER = 'file,pages,status,blocking_score,polish_score,findings,occurrences,critical,serious,moderate,advisory';

export function toCsvRow(report) {
  const summary = report.summary || {};
  const document = report.document || {};
  const values = [
    report.file && report.file.name,
    document.pageCount,
    summary.status,
    summary.blockingScore,
    summary.polishScore,
    summary.findings,
    summary.occurrences,
    summary.critical,
    summary.serious,
    summary.moderate,
    summary.advisory,
  ];
  return values.map(csvCell).join(',');
}

function ruleMap(report) {
  const map = new Map();
  for (const finding of report.findings || []) {
    const existing = map.get(finding.ruleId);
    if (existing) {
      existing.occurrences += finding.occurrences || 1;
      for (const page of (finding.evidence && finding.evidence.pages) || []) existing.pages.add(page);
      if (finding.page != null) existing.pages.add(finding.page);
    } else {
      const pages = new Set((finding.evidence && finding.evidence.pages) || []);
      if (finding.page != null) pages.add(finding.page);
      map.set(finding.ruleId, { ...finding, occurrences: finding.occurrences || 1, pages });
    }
  }
  return map;
}

/**
 * Compare two reports at rule level. Returns { compatible: false, reason } when
 * the reports describe different documents (different SHA-256) unless the
 * caller explicitly allows it.
 */
export function compareReports(before, after, options = {}) {
  if (!before || !after || before.tool !== 'pdf-a11y-audit' || after.tool !== 'pdf-a11y-audit') {
    return { compatible: false, reason: 'Both inputs must be pdf-a11y-audit JSON reports.' };
  }
  const beforeHash = before.file && before.file.sha256;
  const afterHash = after.file && after.file.sha256;
  if (!options.allowDifferent && beforeHash && afterHash && beforeHash !== afterHash) {
    return {
      compatible: false,
      reason: 'The two reports describe different documents (different SHA-256). Re-run on the same file, or pass allowDifferent: true to compare anyway.',
    };
  }
  const oldMap = ruleMap(before);
  const newMap = ruleMap(after);
  const created = [];
  const fixed = [];
  const persisting = [];
  for (const [ruleId, finding] of newMap.entries()) {
    const old = oldMap.get(ruleId);
    if (!old) { created.push({ ruleId, ...finding }); continue; }
    const delta = finding.occurrences - old.occurrences;
    persisting.push({ ruleId, occurrencesBefore: old.occurrences, occurrencesAfter: finding.occurrences, delta });
  }
  for (const [ruleId, finding] of oldMap.entries()) if (!newMap.has(ruleId)) fixed.push({ ruleId, ...finding });
  const summaryOf = (report) => report.summary || {};
  return {
    compatible: true,
    before: { name: before.file.name, sha256: beforeHash, blockingScore: summaryOf(before).blockingScore, polishScore: summaryOf(before).polishScore, status: summaryOf(before).status },
    after: { name: after.file.name, sha256: afterHash, blockingScore: summaryOf(after).blockingScore, polishScore: summaryOf(after).polishScore, status: summaryOf(after).status },
    scoreDelta: {
      blocking: (summaryOf(after).blockingScore || 0) - (summaryOf(before).blockingScore || 0),
      polish: (summaryOf(after).polishScore || 0) - (summaryOf(before).polishScore || 0),
    },
    newFindings: created,
    fixedFindings: fixed,
    persisting,
    summary: { new: created.length, fixed: fixed.length, persisting: persisting.length },
  };
}

function sarifLevel(severity) {
  if (severity === 'critical' || severity === 'serious') return 'error';
  if (severity === 'moderate') return 'warning';
  return 'note';
}

/** SARIF 2.1.0 output for CI code-scanning integrations. */
export function toSarif(report) {
  const failedIds = new Set((report.findings || []).map((finding) => finding.ruleId));
  const rules = RULES.filter((rule) => failedIds.has(rule.id)).map((rule) => ({
    id: rule.id,
    name: rule.title.replace(/[^A-Za-z0-9]+/g, ''),
    shortDescription: { text: rule.title },
    fullDescription: { text: rule.summary },
    help: { text: `${rule.summary} ${rule.remediation || ''}`.trim(), markdown: `${rule.summary}\n\n**Remediation:** ${rule.remediation || 'Review manually.'}` },
    defaultConfiguration: { level: sarifLevel(rule.severity) },
    properties: { tags: ['accessibility', 'pdf', rule.category], severity: rule.severity, standards: rule.standards || [] },
  }));
  const results = (report.findings || []).map((finding) => ({
    ruleId: finding.ruleId,
    level: sarifLevel(finding.severity),
    message: { text: `${finding.message}${finding.occurrences > 1 ? ` (${finding.occurrences} occurrences)` : ''}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: report.file.name },
        region: { startLine: finding.page || 1 },
      },
      properties: { page: finding.page || null },
    }],
    partialFingerprints: { pdfA11yFinding: [finding.ruleId, finding.page || 0, finding.message || ''].join('|') },
    properties: { severity: finding.severity, occurrences: finding.occurrences || 1, evidence: finding.evidence || null },
  }));
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'pdf-a11y-audit',
          informationUri: 'https://remediatepdf.com/open/pdf-a11y-audit',
          version: String(report.version || ''),
          rules,
        },
      },
      results,
      properties: {
        blockingScore: report.summary && report.summary.blockingScore,
        polishScore: report.summary && report.summary.polishScore,
        status: report.summary && report.summary.status,
        scoreModel: report.scoreModel || 'triage-2',
      },
    }],
  }, null, 2);
}

export { CSV_HEADER };

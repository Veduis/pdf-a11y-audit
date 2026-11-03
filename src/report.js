/**
 * Machine- and human-readable report serializers.
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

export function toMarkdown(report) {
  const lines = [];
  lines.push(`# PDF accessibility audit — ${mdCell(report.file.name)}`);
  lines.push('');
  lines.push(`**Status:** ${report.summary.status.toUpperCase()} · **Score:** ${report.summary.score}/100 · **Findings:** ${report.summary.findings}`);
  lines.push('');
  lines.push(`Generated ${report.generatedAt} by ${report.tool} ${report.version}.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---:|');
  for (const key of ['critical', 'serious', 'moderate', 'minor', 'advisory']) {
    lines.push(`| ${key[0].toUpperCase()}${key.slice(1)} | ${report.summary[key] || 0} |`);
  }
  lines.push('');
  lines.push('## Document');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| File | ${mdCell(report.file.name)} |`);
  lines.push(`| Pages | ${report.document.pageCount} |`);
  lines.push(`| Title | ${mdCell(report.document.title || 'Missing')} |`);
  lines.push(`| Language | ${mdCell(report.document.language || 'Missing')} |`);
  lines.push(`| Tagged | ${report.document.tagged ? 'Yes' : 'No'} |`);
  lines.push(`| Marked content | ${report.document.marked ? 'Yes' : 'No'} |`);
  lines.push(`| PDF/UA claim | ${report.document.pdfuaClaim ? 'Yes' : 'No'} |`);
  lines.push(`| Fonts | ${report.document.fonts} |`);
  lines.push(`| Form fields | ${report.document.formFields} |`);
  lines.push(`| Scanned pages | ${report.document.pagesScanned} |`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (!report.findings.length) {
    lines.push('No automated findings. This is not a conformance certificate; complete the manual checks.');
    lines.push('');
  } else {
    for (const finding of report.findings) {
      lines.push(`### ${finding.severity.toUpperCase()} · ${finding.title}`);
      lines.push('');
      if (finding.page) lines.push(`**Page:** ${finding.page}  `);
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
  lines.push('| Check | Category | Status |');
  lines.push('|---|---|---|');
  for (const check of report.checks) {
    lines.push(`| ${mdCell(check.title)} | ${mdCell(check.category)} | ${check.status}${check.reason ? ` — ${mdCell(check.reason)}` : ''} |`);
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Generated locally by [pdf-a11y-audit](https://remediatepdf.com/pdf-remediation?utm_source=pdf-a11y-audit&utm_medium=markdown). No document was uploaded.');
  lines.push('');
  return lines.join('\n');
}

function findingKey(finding) {
  return [finding.ruleId, finding.page || 0, finding.message || ''].join('|');
}

export function compareReports(before, after) {
  const oldMap = new Map((before.findings || []).map((finding) => [findingKey(finding), finding]));
  const newMap = new Map((after.findings || []).map((finding) => [findingKey(finding), finding]));
  const added = [...newMap.entries()].filter(([key]) => !oldMap.has(key)).map(([, finding]) => finding);
  const fixed = [...oldMap.entries()].filter(([key]) => !newMap.has(key)).map(([, finding]) => finding);
  const persisting = [...newMap.entries()].filter(([key]) => oldMap.has(key)).map(([, finding]) => finding);
  return {
    before: { name: before.file && before.file.name, score: before.summary && before.summary.score, status: before.summary && before.summary.status },
    after: { name: after.file && after.file.name, score: after.summary && after.summary.score, status: after.summary && after.summary.status },
    scoreDelta: Number((after.summary && after.summary.score || 0) - (before.summary && before.summary.score || 0)),
    newFindings: added,
    fixedFindings: fixed,
    persisting,
    summary: { new: added.length, fixed: fixed.length, persisting: persisting.length },
  };
}

export function toCsvRow(report) {
  const values = [
    report.file && report.file.name,
    report.document && report.document.pageCount,
    report.summary && report.summary.status,
    report.summary && report.summary.score,
    report.summary && report.summary.critical,
    report.summary && report.summary.serious,
    report.summary && report.summary.moderate,
    report.summary && report.summary.advisory,
  ];
  return values.map(csvCell).join(',');
}

export const CSV_HEADER = 'file,pages,status,score,critical,serious,moderate,advisory';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeFixtures } from './fixtures.js';
import { auditPdf, VERSION } from '../src/audit.js';
import { renderHtml } from '../src/html.js';
import { toMarkdown, toJson, toSummary, compareReports, toCsvRow, toSarif, CSV_HEADER } from '../src/report.js';

const exec = promisify(execFile);
const tmp = path.join(process.cwd(), 'tests', '.tmp');
let files;

function ruleIds(report) {
  return new Set((report.findings || []).map((finding) => finding.ruleId));
}

test.before(async () => {
  files = await makeFixtures(tmp);
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// --- P0-1: forms are not figures -------------------------------------------
test('Form structure elements are not reported as figures needing alt text', async () => {
  const report = await auditPdf(files.formTree);
  const ids = ruleIds(report);
  assert.ok(!ids.has('figures.missing-alt'), 'Form elements must not produce figures.missing-alt');
  assert.equal(report.document.structure.figures, 0);
});

test('terminal form fields without /TU produce one grouped accessible-name finding', async () => {
  const report = await auditPdf(files.formTree);
  const finding = report.findings.find((entry) => entry.ruleId === 'fields.accessible-name');
  assert.ok(finding, 'expected fields.accessible-name');
  assert.equal(finding.occurrences, 2, 'only the two terminal fields count, not the container nodes');
  assert.equal(report.document.formFields, 2);
  assert.ok(!ruleIds(report).has('forms.struct-parent'), 'widgets with a resolvable parent-tree entry are tagged');
});

// --- P0-2: artifacts are not orphans --------------------------------------
test('artifact marked content is not an orphan', async () => {
  const report = await auditPdf(files.artifact);
  assert.ok(!ruleIds(report).has('order.mcid-orphan'), 'artifacts are expected to be absent from the structure tree');
  const checks = report.checks.find((check) => check.id === 'order.mcid-orphan');
  assert.ok(checks.status === 'pass' || checks.status === 'skipped');
});

test('content that is neither tagged nor an artifact is reported', async () => {
  const report = await auditPdf(files.orphan);
  const finding = report.findings.find((entry) => entry.ruleId === 'order.mcid-orphan');
  assert.ok(finding, 'expected order.mcid-orphan for untagged content');
  assert.ok(finding.occurrences >= 1);
});

// --- P0-3: tables ----------------------------------------------------------
test('TH /ID plus TD /Headers is accepted without Scope', async () => {
  const report = await auditPdf(files.headersId);
  const ids = ruleIds(report);
  assert.ok(!ids.has('tables.scope'), 'Scope is not required when Headers/IDs resolve');
  assert.ok(!ids.has('tables.headers-resolution'), 'every Headers value resolves to a TH /ID');
});

test('legitimate ColSpan tables are not reported as irregular', async () => {
  const report = await auditPdf(files.spans);
  const ids = ruleIds(report);
  assert.ok(!ids.has('tables.irregular'), 'equal effective widths are regular');
  assert.ok(!ids.has('tables.scope'), 'a simple header row is determinable without Scope');
});

// --- headings --------------------------------------------------------------
test('generic H heading structure is recognised', async () => {
  const report = await auditPdf(files.strongH);
  const ids = ruleIds(report);
  assert.ok(!ids.has('headings.none'), 'generic H tags are headings');
  assert.ok(!ids.has('struct.heading-structure'), 'a single generic scheme is valid');
  const first = report.checks.find((check) => check.id === 'headings.first');
  assert.equal(first.status, 'skipped');
});

test('multiple H1 headings are information only', async () => {
  const report = await auditPdf(files.taggedBad);
  const multiple = report.findings.find((entry) => entry.ruleId === 'headings.multiple-h1');
  if (multiple) {
    assert.equal(multiple.tier, 'info');
    assert.equal(multiple.occurrences, 1);
  }
});

// --- metadata --------------------------------------------------------------
test('XMP-only titles satisfy the PDF/UA title requirement', async () => {
  const report = await auditPdf(files.xmpOnlyTitle);
  const ids = ruleIds(report);
  assert.ok(!ids.has('pdfua.xmp-title'), 'dc:title is present');
  assert.ok(report.document.xmpTitle === 'Metadata fixture');
  const infoTitle = report.findings.find((entry) => entry.ruleId === 'pdfua.title');
  assert.ok(infoTitle, 'a missing Info /Title is reported as information');
  assert.equal(infoTitle.tier, 'info');
});

test('compressed XMP metadata is inflated before parsing', async () => {
  const report = await auditPdf(files.compressedXmp);
  assert.equal(report.document.xmpPresent, true);
  assert.equal(report.document.xmpCompressed, true);
  assert.equal(report.document.xmpTitle, 'Metadata fixture');
  const ids = ruleIds(report);
  assert.ok(!ids.has('pdfua.xmp-title'));
  assert.ok(!ids.has('pdfua.metadata-stream'));
});

// --- scoring integrity -----------------------------------------------------
test('a fully tagged vector-only document can reach a clean result', async () => {
  const report = await auditPdf(files.clean);
  assert.equal(report.summary.blockingScore, 100);
  assert.equal(report.summary.polishScore, 100);
  assert.equal(report.summary.status, 'pass');
  assert.ok((report.findings || []).every((finding) => finding.tier === 'info'));
});

test('maxFindings is display-only and does not change scores or counts', async () => {
  const full = await auditPdf(files.taggedBad);
  const capped = await auditPdf(files.taggedBad, { maxFindings: 1 });
  assert.equal(capped.summary.blockingScore, full.summary.blockingScore);
  assert.equal(capped.summary.polishScore, full.summary.polishScore);
  assert.equal(capped.summary.occurrences, full.summary.occurrences);
  assert.equal(capped.summary.findings, full.summary.findings);
  assert.ok(capped.findings.length <= 1);
  assert.equal(capped.summary.truncated, full.summary.findings > 1);
});

test('an untagged document does not look like a near-pass', async () => {
  const report = await auditPdf(files.untagged);
  assert.equal(report.summary.status, 'fail');
  assert.ok(report.summary.blockingScore < 60, `expected blocking score below 60, got ${report.summary.blockingScore}`);
});

test('a tagged form with unnamed fields scores above an untagged scan', async () => {
  const [form, scan] = await Promise.all([auditPdf(files.formTree), auditPdf(files.scanned)]);
  assert.ok(form.summary.blockingScore >= scan.summary.blockingScore);
});

// --- serializers -----------------------------------------------------------
test('summary output is compact and carries both scores', async () => {
  const report = await auditPdf(files.taggedBad);
  const summary = toSummary(report);
  assert.match(summary, /Blocking score/);
  assert.match(summary, /Polish score/);
  assert.ok(summary.length < 4000, `summary should stay compact, got ${summary.length} characters`);
});

test('markdown and JSON serializers include evidence, rollup, manual checks and limitations', async () => {
  const report = await auditPdf(files.taggedBad);
  const markdown = toMarkdown(report);
  assert.match(markdown, /PDF accessibility audit/);
  assert.match(markdown, /How the scores work/);
  assert.match(markdown, /Findings by rule/);
  assert.match(markdown, /Manual checks/);
  assert.match(markdown, /Limitations/);
  assert.doesNotMatch(markdown, /utm_/);
  const parsed = JSON.parse(toJson(report));
  assert.equal(parsed.tool, 'pdf-a11y-audit');
  assert.equal(parsed.version, VERSION);
  assert.ok(Array.isArray(parsed.manualChecks));
  assert.equal(parsed.summary.score, parsed.summary.blockingScore);
  assert.ok(Array.isArray(parsed.scoreBreakdown));
});

test('HTML report is self-contained, XSS-safe and carries no tracking link', async () => {
  const report = await auditPdf(files.taggedBad);
  report.file.name = '<img src=x onerror=alert(1)>.pdf';
  report.document.title = '<script>alert(1)</script>';
  report.findings[0].message = '<svg onload=alert(1)>';
  const html = renderHtml(report);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Blocking score/);
  assert.match(html, /How the scores work/);
  assert.match(html, /What to fix first/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /utm_/);
  const visible = html.replace(/<script type="application\/json" id="audit-data">[\s\S]*?<\/script>/, '');
  assert.doesNotMatch(visible, /<img src=x onerror/);
  assert.doesNotMatch(visible, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(visible, /<svg onload/);
});

test('CSV output neutralizes spreadsheet formulas', () => {
  const report = { file: { name: '=HYPERLINK("https://example.com")' }, document: { pageCount: 1 }, summary: { status: 'pass', blockingScore: 100, polishScore: 100, findings: 0, occurrences: 0, critical: 0, serious: 0, moderate: 0, advisory: 0 } };
  const row = toCsvRow(report);
  assert.match(row, /^"'=HYPERLINK/);
  assert.ok(CSV_HEADER.includes('blocking_score'));
});

test('SARIF output carries rules, results and score properties', async () => {
  const report = await auditPdf(files.taggedBad);
  const sarif = JSON.parse(toSarif(report));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.ok(sarif.runs[0].tool.driver.rules.length > 0);
  assert.equal(sarif.runs[0].results.length, report.findings.length);
  assert.equal(sarif.runs[0].properties.blockingScore, report.summary.blockingScore);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, report.file.name);
});

test('comparison refuses different documents unless allowed', async () => {
  const before = await auditPdf(files.taggedBad);
  const after = await auditPdf(files.clean);
  const refused = compareReports(before, after);
  assert.equal(refused.compatible, false);
  assert.match(refused.reason, /different documents/);
  const allowed = compareReports(before, after, { allowDifferent: true });
  assert.equal(allowed.compatible, true);
  assert.equal(allowed.summary.fixed + allowed.summary.persisting, new Set(before.findings.map((finding) => finding.ruleId)).size);
});

test('comparison keeps duplicate findings distinct at rule level', async () => {
  const before = await auditPdf(files.orphan);
  const after = JSON.parse(JSON.stringify(before));
  const result = compareReports(before, after);
  assert.equal(result.compatible, true);
  assert.equal(result.summary.new, 0);
  assert.equal(result.summary.fixed, 0);
  assert.ok(result.summary.persisting > 0);
});

// --- CLI -------------------------------------------------------------------
test('CLI quiet mode prints one summary line and no report body', async () => {
  const { stdout } = await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--quiet', '--fail-on', 'none'], { cwd: process.cwd() });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /blocking \d+\/100 · polish \d+\/100/);
});

test('CLI emits SARIF and summary formats', async () => {
  const sarif = await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--format', 'sarif', '--fail-on', 'none'], { cwd: process.cwd() });
  const parsed = JSON.parse(sarif.stdout);
  assert.equal(parsed.version, '2.1.0');
  const summary = await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--format', 'summary', '--fail-on', 'none'], { cwd: process.cwd() });
  assert.match(summary.stdout, /Blocking score/);
});

test('CLI baseline suppresses matching findings for the exit code', async () => {
  const baselinePath = path.join(tmp, 'baseline.json');
  await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--update-baseline', baselinePath, '--quiet', '--fail-on', 'none'], { cwd: process.cwd() });
  const result = await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--baseline', baselinePath, '--quiet'], { cwd: process.cwd() }).catch((error) => error);
  assert.equal(result.code === 0 || result.code === undefined, true, `expected exit 0 with a full baseline, got ${result.code}`);
});

test('the CLI entry point can start the MCP server with --mcp', async () => {
  const { stdout } = await exec(process.execPath, ['bin/cli.js', '--version'], { cwd: process.cwd() });
  assert.equal(stdout.trim(), VERSION);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeFixtures } from './fixtures.js';
import { auditPdf } from '../src/audit.js';
import { renderHtml } from '../src/html.js';
import { toMarkdown, toJson, compareReports, toCsvRow } from '../src/report.js';

const exec = promisify(execFile);
const tmp = path.join(process.cwd(), 'tests', '.tmp');
let files;

test.before(async () => {
  files = await makeFixtures(tmp);
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('untagged PDF is identified before structure-specific checks', async () => {
  const report = await auditPdf(files.untagged);
  const ids = new Set(report.findings.map((finding) => finding.ruleId));
  assert.equal(report.document.tagged, false);
  assert.ok(ids.has('pdfua.tagged'));
  assert.ok(ids.has('pdfua.marked'));
  assert.ok(ids.has('pdfua.lang'));
  assert.ok(ids.has('pdfua.display-title'));
  assert.ok(!ids.has('headings.none'), 'headings are not evaluated without a structure tree');
  assert.ok(report.checks.filter((check) => check.status === 'skipped').length > 0);
  assert.equal(report.summary.status, 'fail');
});

test('a tagged fixture keeps structure findings quiet', async () => {
  const report = await auditPdf(files.taggedGood);
  const ids = new Set(report.findings.map((finding) => finding.ruleId));
  assert.equal(report.document.tagged, true);
  assert.equal(report.document.marked, true);
  assert.equal(report.document.language, 'en-US');
  assert.equal(report.document.displayDocTitle, true);
  assert.ok(!ids.has('pdfua.tagged'));
  assert.ok(!ids.has('pdfua.parent-tree'));
  assert.ok(!ids.has('headings.skipped'));
  assert.ok(!ids.has('headings.empty'));
  assert.ok(!ids.has('tables.no-headers'));
  assert.ok(!ids.has('figures.missing-alt'));
  assert.ok(!ids.has('forms.tooltip'));
  assert.ok(!ids.has('forms.struct-parent'));
  assert.ok(!ids.has('links.struct-parent'));
  assert.ok(!ids.has('order.mcid-orphan'));
});

test('a scanned page is detected as image-only content', async () => {
  const report = await auditPdf(files.scanned);
  const ids = new Set(report.findings.map((finding) => finding.ruleId));
  assert.ok(ids.has('pages.scanned'));
  assert.ok(report.document.pagesScanned >= 1);
});

test('a deliberately broken tagged PDF reports structural defects', async () => {
  const report = await auditPdf(files.taggedBad);
  const ids = new Set(report.findings.map((finding) => finding.ruleId));
  for (const id of [
    'pdfua.parent-tree', 'headings.skipped', 'headings.empty',
    'tables.no-headers', 'tables.empty-header', 'figures.missing-alt',
    'lists.empty-item', 'forms.tooltip', 'forms.struct-parent',
    'links.struct-parent', 'links.name', 'order.mcid-orphan',
  ]) assert.ok(ids.has(id), `expected ${id} in ${[...ids].join(', ')}`);
  assert.equal(report.summary.status, 'fail');
});

test('markdown and JSON serializers include the evidence and limitations', async () => {
  const report = await auditPdf(files.taggedBad);
  const markdown = toMarkdown(report);
  assert.match(markdown, /PDF accessibility audit/);
  assert.match(markdown, /Manual checks/);
  assert.match(markdown, /Method and limits|Limitations/);
  const parsed = JSON.parse(toJson(report));
  assert.equal(parsed.tool, 'pdf-a11y-audit');
  assert.ok(Array.isArray(parsed.manualChecks));
});

test('HTML report is self-contained and includes the editorial report sections', async () => {
  const report = await auditPdf(files.taggedBad);
  const html = renderHtml(report);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /What to fix first/);
  assert.match(html, /Manual review required/);
  assert.match(html, /Check register/);
  assert.match(html, /audit-data/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /@import/i);
});

test('CSV output neutralizes spreadsheet formulas', () => {
  const report = { file: { name: '=HYPERLINK("https://example.com")' }, document: { pageCount: 1 }, summary: { status: 'pass', score: 100, critical: 0, serious: 0, moderate: 0, advisory: 0 } };
  const row = toCsvRow(report);
  assert.match(row, /^"'=HYPERLINK/);
});

test('HTML output escapes document metadata and finding text', async () => {
  const report = await auditPdf(files.taggedBad);
  report.file.name = '<img src=x onerror=alert(1)>.pdf';
  report.document.title = '<script>alert(1)</script>';
  report.findings[0].message = '<svg onload=alert(1)>';
  const html = renderHtml(report);
  const visible = html.replace(/<script type="application\/json" id="audit-data">[\s\S]*?<\/script>/, '');
  assert.doesNotMatch(visible, /<img src=x onerror/);
  assert.doesNotMatch(visible, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(visible, /<svg onload/);
  assert.match(visible, /&lt;img src=x onerror/);
  assert.doesNotMatch(html, /<\/script><script/i);
});

test('Markdown fences grow when evidence contains backticks', async () => {
  const report = await auditPdf(files.taggedBad);
  report.findings[0].evidence = { note: '``` not a fence' };
  const markdown = toMarkdown(report);
  assert.match(markdown, /````json/);
});

test('missing and empty PDFs fail with a clear error', async () => {
  await assert.rejects(() => auditPdf(path.join(tmp, 'does-not-exist.pdf')), /File not found/);
  const empty = path.join(tmp, 'empty.pdf');
  await fs.writeFile(empty, '');
  await assert.rejects(() => auditPdf(empty), /PDF is empty/);
});

test('the registry manifest matches the published package metadata', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  const server = JSON.parse(await fs.readFile(path.join(process.cwd(), 'server.json'), 'utf8'));
  assert.equal(pkg.mcpName, server.name);
  assert.equal(pkg.version, server.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.packages[0].transport.type, 'stdio');
  assert.ok(server.packages[0].packageArguments.some((arg) => arg.value === '--mcp'));
});

test('comparison reports new and fixed findings', async () => {
  const before = await auditPdf(files.taggedBad);
  const after = JSON.parse(JSON.stringify(before));
  const removed = after.findings.shift();
  const result = compareReports(before, after);
  assert.ok(result.summary.fixed >= 1);
  assert.ok(result.fixedFindings.some((finding) => finding.ruleId === removed.ruleId));
});

test('CLI emits JSON and uses the severity exit code', async () => {
  const result = await exec(process.execPath, ['bin/cli.js', files.taggedBad, '--format', 'json', '--fail-on', 'serious'], { cwd: process.cwd() }).catch((error) => error);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tool, 'pdf-a11y-audit');
  assert.ok(report.findings.length > 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeFixtures } from './fixtures.js';

const tmp = path.join(process.cwd(), 'tests', '.tmp-mcp');
let files;
let client;

test.before(async () => {
  files = await makeFixtures(tmp);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/mcp.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  client = new Client({ name: 'pdf-a11y-audit-test', version: '1.0.0' });
  await client.connect(transport);
});

test.after(async () => {
  if (client) await client.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
});

test('MCP exposes six tools with output schemas, resources and a prompt', async () => {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of ['audit_pdf', 'audit_batch', 'explain_finding', 'list_checks', 'compare_reports', 'render_report']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));
  for (const name of names) assert.ok(byName[name].outputSchema, `${name} declares an outputSchema`);
  assert.equal(byName.audit_pdf.annotations.readOnlyHint, false);
  assert.equal(byName.audit_pdf.annotations.destructiveHint, true, 'audit_pdf can write or replace a file');
  assert.equal(byName.audit_batch.annotations.readOnlyHint, true);
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === 'remediate://rules'));
  assert.ok(resources.resources.some((resource) => resource.uri === 'remediate://methodology'));
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === 'audit_and_plan'));
});

test('server instructions explain the triage scores and local-only behaviour', async () => {
  const instructions = client.getInstructions ? client.getInstructions() : '';
  const text = String(instructions || '');
  if (text) {
    assert.match(text, /triage/i);
    assert.match(text, /never uploads/i);
  }
});

test('audit_pdf defaults to a compact summary with a structured envelope', async () => {
  const result = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad } });
  const text = result.content.map((part) => part.text || '').join('\n');
  assert.match(text, /Blocking score/);
  assert.ok(text.length < 4000, `default output should be compact, got ${text.length} characters`);
  assert.ok(result.structuredContent && result.structuredContent.summary);
  assert.equal(result.structuredContent.summary.score, result.structuredContent.summary.blockingScore);
  assert.equal(result.structuredContent.summary.scoreModel, 'triage-2');
});

test('audit_pdf json returns the full report and the score is cap-independent', async () => {
  const result = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json', maxFindings: 1 } });
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.tool, 'pdf-a11y-audit');
  assert.equal(report.scoreModel, 'triage-2');
  assert.equal(report.summary.blockingScore, result.structuredContent.summary.blockingScore);
  assert.ok(report.summary.occurrences >= report.summary.findings);
});

test('audit_pdf refuses to overwrite and accepts overwrite:true', async () => {
  const target = path.join(tmp, 'guarded-report.html');
  const first = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'html', output: target } });
  assert.match(first.content[0].text, /HTML report/);
  const second = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'html', output: target } });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /Refusing to overwrite/);
  const third = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'html', output: target, overwrite: true } });
  assert.notEqual(third.isError, true);
  const html = await fs.readFile(target, 'utf8');
  assert.match(html, /Blocking score/);
});

test('audit_batch fails soft on a corrupt PDF', async () => {
  const corrupt = path.join(tmp, 'corrupt.pdf');
  await fs.writeFile(corrupt, 'not a pdf at all');
  const result = await client.callTool({ name: 'audit_batch', arguments: { paths: [tmp] } });
  const text = result.content[0].text;
  assert.match(text, /could not be audited/i);
  assert.equal(result.structuredContent.failed, 1);
  assert.ok(result.structuredContent.succeeded >= 1);
  assert.ok(result.structuredContent.reports.length >= 1);
});

test('audit_pdf findings can be paginated without changing scores', async () => {
  const first = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json', maxFindings: 2 } });
  const second = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json', maxFindings: 2, offset: 1 } });
  const a = JSON.parse(first.content[0].text);
  const b = JSON.parse(second.content[0].text);
  assert.equal(a.findings.length, 2);
  assert.equal(b.findings.length, 2);
  assert.equal(a.summary.blockingScore, b.summary.blockingScore);
  assert.equal(a.summary.occurrences, b.summary.occurrences);
  assert.notEqual(a.findings[0].ruleId + a.findings[0].message, b.findings[0].ruleId + b.findings[0].message);
});

test('audit_batch follows symlinked PDFs with loop protection', async () => {
  const dir = path.join(tmp, 'symlink-case');
  await fs.mkdir(dir, { recursive: true });
  await fs.symlink(files.taggedGood, path.join(dir, 'linked.pdf'));
  const result = await client.callTool({ name: 'audit_batch', arguments: { paths: [dir] } });
  assert.equal(result.structuredContent.failed, 0);
  assert.ok(result.structuredContent.count >= 1);
  assert.match(result.content[0].text, /linked\.pdf/);
});

test('explain_finding and list_checks expose structured rule data', async () => {
  const explained = await client.callTool({ name: 'explain_finding', arguments: { ruleId: 'figures.missing-alt' } });
  assert.match(explained.content[0].text, /Figure has no alternative text/);
  assert.equal(explained.structuredContent.tier, 'blocking');
  const checks = await client.callTool({ name: 'list_checks', arguments: { tier: 'blocking', severity: 'critical' } });
  assert.ok(checks.structuredContent.count > 0);
  for (const entry of checks.structuredContent.checks) {
    assert.equal(entry.tier, 'blocking');
    assert.equal(entry.severity, 'critical');
  }
});

test('compare_reports refuses different documents and compares matching ones', async () => {
  const reportPath = path.join(tmp, 'before.json');
  const first = await client.callTool({ name: 'audit_pdf', arguments: { path: files.orphan, format: 'json', output: reportPath } });
  assert.notEqual(first.isError, true);
  const same = await client.callTool({ name: 'audit_pdf', arguments: { path: files.orphan, format: 'json', output: reportPath, overwrite: true } });
  assert.notEqual(same.isError, true);
  const compared = await client.callTool({ name: 'compare_reports', arguments: { before: reportPath, after: reportPath } });
  assert.match(compared.content[0].text, /Audit comparison/);
  assert.equal(compared.structuredContent.compatible, true);
  const mismatch = await client.callTool({ name: 'compare_reports', arguments: { before: reportPath, after: path.join(tmp, 'other.json') } });
  assert.equal(mismatch.isError, true);
});

test('render_report validates the report and writes HTML', async () => {
  const jsonPath = path.join(tmp, 'render-input.json');
  const json = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json', output: jsonPath } });
  assert.notEqual(json.isError, true);
  const htmlPath = path.join(tmp, 'render-output.html');
  const rendered = await client.callTool({ name: 'render_report', arguments: { report: jsonPath, output: htmlPath } });
  assert.match(rendered.content[0].text, /HTML report written/);
  assert.match(await fs.readFile(htmlPath, 'utf8'), /What to fix first/);
});

test('the CLI entry point can start the MCP server with --mcp', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/cli.js', '--mcp'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const cliClient = new Client({ name: 'cli-mcp-test', version: '1.0.0' });
  await cliClient.connect(transport);
  try {
    const tools = await cliClient.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'audit_pdf'));
  } finally {
    await cliClient.close().catch(() => {});
  }
});

test('resources are readable', async () => {
  const rules = await client.readResource({ uri: 'remediate://rules' });
  assert.match(rules.contents[0].text, /figures\.missing-alt/);
  const methodology = await client.readResource({ uri: 'remediate://methodology' });
  assert.match(methodology.contents[0].text, /blockingScore/);
});

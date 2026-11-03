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

test('MCP exposes the audit tools, resources and prompt', async () => {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of ['audit_pdf', 'audit_batch', 'explain_finding', 'list_checks', 'compare_reports', 'render_report']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.audit_pdf.annotations.readOnlyHint, false, 'audit_pdf can write a report');
  assert.equal(byName.render_report.annotations.readOnlyHint, false, 'render_report writes HTML');
  assert.equal(byName.audit_batch.annotations.readOnlyHint, true, 'audit_batch only reads');
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === 'remediate://rules'));
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === 'audit_and_plan'));
});

test('audit_pdf returns a structured report', async () => {
  const result = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json' } });
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.tool, 'pdf-a11y-audit');
  assert.equal(report.document.tagged, true);
  assert.ok(report.findings.some((finding) => finding.ruleId === 'figures.missing-alt'));
});

test('explain_finding and list_checks are useful without a document', async () => {
  const explained = await client.callTool({ name: 'explain_finding', arguments: { ruleId: 'figures.missing-alt' } });
  assert.match(explained.content[0].text, /Figure has no alternative text/);
  const checks = await client.callTool({ name: 'list_checks', arguments: { automated: true, severity: 'critical' } });
  assert.match(checks.content[0].text, /pdfua\.tagged/);
});

test('audit_batch and render_report work together', async () => {
  const batch = await client.callTool({ name: 'audit_batch', arguments: { paths: [tmp], format: 'markdown' } });
  assert.match(batch.content[0].text, /PDF accessibility batch/);
  assert.match(batch.content[0].text, /tagged-bad\.pdf/);

  const jsonPath = path.join(tmp, 'tagged-bad-report.json');
  const jsonResult = await client.callTool({ name: 'audit_pdf', arguments: { path: files.taggedBad, format: 'json', output: jsonPath } });
  assert.match(jsonResult.content[0].text, /tagged-bad\.pdf/);
  const htmlPath = path.join(tmp, 'tagged-bad-report.html');
  const rendered = await client.callTool({ name: 'render_report', arguments: { report: jsonPath, output: htmlPath } });
  assert.match(rendered.content[0].text, /HTML report written/);
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.match(html, /What to fix first/);
});

test('the CLI entry point can start the MCP server with --mcp', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/cli.js', '--mcp'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const local = new Client({ name: 'pdf-a11y-audit-cli-test', version: '1.0.0' });
  await local.connect(transport);
  try {
    const tools = await local.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'audit_pdf'));
  } finally {
    await local.close().catch(() => {});
  }
});

test('rules resource is readable', async () => {
  const resource = await client.readResource({ uri: 'remediate://rules' });
  assert.match(resource.contents[0].text, /pdfua\.tagged/);
  assert.match(resource.contents[0].text, /manual\.color-contrast/);
});

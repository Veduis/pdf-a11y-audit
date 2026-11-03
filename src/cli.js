#!/usr/bin/env node
/**
 * CLI entry point. Kept dependency-free so the package can be run with npx.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditPdf, VERSION } from '../src/audit.js';
import { renderHtml } from '../src/html.js';
import { toJson, toMarkdown, toCsvRow, CSV_HEADER } from '../src/report.js';

const HELP = `pdf-a11y-audit ${VERSION}

Audit PDF accessibility locally. No upload, no account, no provider calls.

Usage:
  pdf-a11y-audit <file.pdf> [options]
  pdf-a11y-audit <dir> [dir...] --format csv
  pdf-a11y-audit <file.pdf> --format html --out report.html

Options:
  --format <json|markdown|html|csv>  Output format (default: markdown)
  --out <path>                       Write output to a file; "-" writes stdout
  --fail-on <severity|none>          Exit 1 at or above this severity (default: serious)
  --max-findings <n>                 Cap findings per document (default: 500)
  --quiet                            Print only the final summary
  --mcp                              Start the MCP stdio server instead of the CLI
  --help                             Show this help
  --version                          Show the version

Severities: critical, serious, moderate, minor, advisory, none
`;

function parseArgs(argv) {
  const options = { format: 'markdown', out: null, failOn: 'serious', maxFindings: 500, quiet: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--version' || arg === '-v') { options.version = true; continue; }
    if (arg === '--quiet' || arg === '-q') { options.quiet = true; continue; }
    if (arg === '--format' || arg === '-f') { options.format = argv[++index]; continue; }
    if (arg === '--out' || arg === '-o') { options.out = argv[++index]; continue; }
    if (arg === '--fail-on') { options.failOn = argv[++index]; continue; }
    if (arg === '--max-findings') { options.maxFindings = Number(argv[++index]); continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    options.paths.push(arg);
  }
  return options;
}

async function collect(paths, { recursive = false } = {}) {
  const out = [];
  for (const input of paths) {
    const absolute = path.resolve(process.cwd(), input);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) throw new Error(`Not found: ${input}`);
    if (stat.isFile()) { out.push(absolute); continue; }
    if (!stat.isDirectory()) continue;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(path.join(absolute, entry.name));
      if (recursive && entry.isDirectory()) out.push(...await collect([path.join(absolute, entry.name)], { recursive }));
    }
  }
  return [...new Set(out)];
}

const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor', 'advisory'];
function shouldFail(report, failOn) {
  if (!failOn || failOn === 'none') return false;
  const threshold = SEVERITY_ORDER.indexOf(failOn);
  if (threshold < 0) throw new Error(`Unknown severity: ${failOn}`);
  return report.findings.some((finding) => SEVERITY_ORDER.indexOf(finding.severity) <= threshold);
}

function summaryLine(report) {
  return `${report.file.name}: ${report.summary.status} · ${report.summary.score}/100 · ${report.summary.findings} finding${report.summary.findings === 1 ? '' : 's'}`;
}

async function main() {
  if (process.argv.slice(2).includes('--mcp')) {
    const { main: startMcp } = await import('./mcp.js');
    await startMcp();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (!options.paths.length) { process.stderr.write(HELP); process.exitCode = 2; return; }

  const files = await collect(options.paths, { recursive: true });
  if (!files.length) throw new Error('No PDF files found.');

  const reports = [];
  for (const file of files) {
    const report = await auditPdf(file, { maxFindings: options.maxFindings });
    reports.push(report);
    if (!options.quiet && files.length > 1) process.stderr.write(`audited ${file}\n`);
  }

  let output = '';
  if (options.format === 'json') output = files.length === 1 ? toJson(reports[0]) : JSON.stringify(reports, null, 2);
  else if (options.format === 'markdown') output = files.length === 1 ? toMarkdown(reports[0]) : reports.map((report) => `## ${report.file.name}\n\n${summaryLine(report)}\n`).join('\n');
  else if (options.format === 'csv') output = [CSV_HEADER, ...reports.map(toCsvRow)].join('\n');
  else if (options.format === 'html') {
    if (reports.length !== 1) throw new Error('HTML output is available for one document at a time.');
    output = renderHtml(reports[0]);
  } else throw new Error(`Unknown format: ${options.format}`);

  if (options.out && options.out !== '-') {
    const target = path.resolve(process.cwd(), options.out);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output, 'utf8');
    process.stderr.write(`wrote ${target}\n`);
  } else if (!(options.format === 'html' && !options.out)) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  } else {
    const target = path.join(process.cwd(), `${path.basename(files[0], '.pdf')}-a11y-report.html`);
    await fs.writeFile(target, output, 'utf8');
    process.stderr.write(`wrote ${target}\n`);
  }

  if (!options.quiet) {
    for (const report of reports) process.stderr.write(`${summaryLine(report)}\n`);
  }
  if (reports.some((report) => shouldFail(report, options.failOn))) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err && err.message || err}\n`);
  process.exitCode = 2;
});

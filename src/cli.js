#!/usr/bin/env node
/**
 * CLI entry point. Kept dependency-free so the package can be run with npx.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditPdf, VERSION } from '../src/audit.js';
import { renderHtml } from '../src/html.js';
import { toJson, toMarkdown, toSummary, toCsvRow, CSV_HEADER, toSarif } from '../src/report.js';

const HELP = `pdf-a11y-audit ${VERSION}

Audit PDF accessibility locally. No upload, no account, no provider calls.
Reports two triage scores (blocking and polish) plus cited findings. This is not
a PDF/UA validator: use veraPDF or PAC plus a screen reader for conformance.

Usage:
  pdf-a11y-audit <file.pdf> [options]
  pdf-a11y-audit <dir> [dir...] --format csv
  pdf-a11y-audit <file.pdf> --format html --out report.html

Options:
  --format <summary|markdown|json|html|csv|sarif>  Output format (default: markdown)
  --out <path>                       Write output to a file; "-" writes stdout
  --severity <level>                 Only show findings at or above this severity
  --fail-on <severity|none>          Exit 1 at or above this severity (default: serious)
  --baseline <path>                  Suppress findings recorded in a baseline file
  --update-baseline <path>           Write the current findings as a baseline file
  --max-findings <n>                 Cap returned findings (default: 500); scores are unaffected
  --quiet                            Print only the one-line score summary
  --mcp                              Start the MCP stdio server instead of the CLI
  --help                             Show this help
  --version                          Show the version

Severities: critical, serious, moderate, minor, advisory, none
Formats: summary | markdown | json | html | csv | sarif
Run --format json and --format sarif for CI integrations.`;

const FORMATS = ['summary', 'markdown', 'json', 'html', 'csv', 'sarif'];
const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor', 'advisory'];

function parseArgs(argv) {
  const options = {
    format: 'markdown', out: null, failOn: 'serious', maxFindings: 500, quiet: false,
    severity: null, baseline: null, updateBaseline: null, paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--version' || arg === '-v') { options.version = true; continue; }
    if (arg === '--quiet' || arg === '-q') { options.quiet = true; continue; }
    if (arg === '--format' || arg === '-f') { options.format = argv[++index]; continue; }
    if (arg === '--out' || arg === '-o') { options.out = argv[++index]; continue; }
    if (arg === '--fail-on') { options.failOn = argv[++index]; continue; }
    if (arg === '--severity') { options.severity = argv[++index]; continue; }
    if (arg === '--baseline') { options.baseline = argv[++index]; continue; }
    if (arg === '--update-baseline') { options.updateBaseline = argv[++index]; continue; }
    if (arg === '--max-findings') { options.maxFindings = Number(argv[++index]); continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    options.paths.push(arg);
  }
  return options;
}

async function collect(paths, { recursive = true, maxDepth = 8, maxFiles = 5000 } = {}) {
  const out = [];
  const visitedDirs = new Set();
  async function walk(input, depth) {
    if (out.length >= maxFiles) return;
    const absolute = path.resolve(process.cwd(), input);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) throw new Error(`Not found: ${input}`);
    if (stat.isFile()) { out.push(absolute); return; }
    if (!stat.isDirectory() || depth > maxDepth) return;
    let real = absolute;
    try { real = await fs.realpath(absolute); } catch { /* keep absolute */ }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(absolute, entry.name);
      let isPdfFile = entry.isFile() && /\.pdf$/i.test(entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const target = await fs.stat(full).catch(() => null);
        isPdfFile = isPdfFile || !!(target && target.isFile() && /\.pdf$/i.test(entry.name));
        isDirectory = !!(target && target.isDirectory());
      }
      if (isPdfFile) out.push(full);
      if (recursive && isDirectory) await walk(full, depth + 1);
      if (out.length >= maxFiles) return;
    }
  }
  for (const input of paths) await walk(input, 0);
  return [...new Set(out)];
}

function shouldFail(report, failOn, suppressed) {
  if (!failOn || failOn === 'none') return false;
  const threshold = SEVERITY_ORDER.indexOf(failOn);
  if (threshold < 0) throw new Error(`Unknown severity: ${failOn}`);
  return (report.findings || []).some((finding) => !suppressed.has(finding) && SEVERITY_ORDER.indexOf(finding.severity) <= threshold);
}

function summaryLine(report) {
  return `${report.file.name}: ${report.summary.status} · blocking ${report.summary.blockingScore}/100 · polish ${report.summary.polishScore}/100 · ${report.summary.findings} finding${report.summary.findings === 1 ? '' : 's'} (${report.summary.occurrences} occurrences)`;
}

function baselineKey(finding) {
  return `${finding.ruleId}|${finding.page == null ? '' : finding.page}`;
}

async function readBaseline(file) {
  const raw = JSON.parse(await fs.readFile(path.resolve(process.cwd(), file), 'utf8'));
  if (!raw || raw.tool !== 'pdf-a11y-audit-baseline' || !Array.isArray(raw.entries)) {
    throw new Error(`Not a pdf-a11y-audit baseline file: ${file}`);
  }
  return raw;
}

function baselineEntries(report) {
  return (report.findings || []).map((finding) => ({
    ruleId: finding.ruleId,
    page: finding.page == null ? null : finding.page,
    title: finding.title,
    occurrences: finding.occurrences || 1,
  }));
}

function sarifFor(reports) {
  const runs = [];
  for (const report of reports) {
    const parsed = JSON.parse(toSarif(report));
    runs.push(...parsed.runs);
  }
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs,
  }, null, 2);
}

function formatFor(report, options, multiple) {
  if (options.format === 'json') {
    return multiple ? JSON.stringify(report, null, 2) : toJson(report);
  }
  if (options.format === 'summary') return toSummary(report);
  if (options.format === 'markdown') return multiple ? toSummary(report) : toMarkdown(report);
  throw new Error(`Format ${options.format} is not available for multiple documents.`);
}

async function main() {
  if (process.argv.slice(2).includes('--mcp')) {
    const { main: startMcp } = await import('./mcp.js');
    await startMcp();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${HELP}\n`); return; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (!FORMATS.includes(options.format)) throw new Error(`Unknown format: ${options.format}`);
  if (!options.paths.length) { process.stderr.write(`${HELP}\n`); process.exitCode = 2; return; }
  if (options.severity && !SEVERITY_ORDER.includes(options.severity)) {
    throw new Error(`Unknown severity: ${options.severity}`);
  }

  const files = await collect(options.paths);
  if (!files.length) throw new Error('No PDF files found.');
  if (options.format === 'html' && files.length !== 1) throw new Error('HTML output is available for one document at a time.');

  let baseline = null;
  if (options.baseline) baseline = await readBaseline(options.baseline);
  const baselineKeys = new Set((baseline ? baseline.entries : []).map((entry) => `${entry.ruleId}|${entry.page == null ? '' : entry.page}`));

  const reports = [];
  for (const file of files) {
    const report = await auditPdf(file, { maxFindings: options.maxFindings, minSeverity: options.severity, signal: null });
    if (baseline) {
      const suppressed = new Set();
      for (const finding of report.findings || []) if (baselineKeys.has(baselineKey(finding))) suppressed.add(finding);
      report.summary.suppressed = suppressed.size;
      report.baseline = { file: path.resolve(process.cwd(), options.baseline), suppressed: suppressed.size };
      Object.defineProperty(report, '__suppressed', { value: suppressed, enumerable: false });
    }
    reports.push(report);
  }

  if (options.updateBaseline) {
    const target = path.resolve(process.cwd(), options.updateBaseline);
    const payload = {
      tool: 'pdf-a11y-audit-baseline',
      version: VERSION,
      generatedAt: new Date().toISOString(),
      entries: reports.flatMap((report) => baselineEntries(report)),
    };
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stderr.write(`baseline written to ${target} (${payload.entries.length} entries)\n`);
  }

  let output = '';
  if (options.format === 'html') output = renderHtml(reports[0]);
  else if (options.format === 'csv') output = [CSV_HEADER, ...reports.map(toCsvRow)].join('\n');
  else if (options.format === 'sarif') output = sarifFor(reports);
  else output = reports.map((report) => formatFor(report, options, reports.length > 1)).join('\n\n');

  if (options.out && options.out !== '-') {
    const target = path.resolve(process.cwd(), options.out);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output, 'utf8');
    process.stderr.write(`wrote ${target}\n`);
    if (options.quiet) for (const report of reports) process.stdout.write(`${summaryLine(report)}\n`);
  } else if (options.quiet) {
    for (const report of reports) process.stdout.write(`${summaryLine(report)}\n`);
  } else if (options.format === 'html') {
    const report = reports[0];
    const extension = path.extname(report.file.name);
    const target = path.join(process.cwd(), `${path.basename(report.file.name, extension)}-a11y-report.html`);
    await fs.writeFile(target, output, 'utf8');
    process.stderr.write(`wrote ${target}\n`);
  } else {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }

  const failed = reports.some((report) => shouldFail(report, options.failOn, report.__suppressed || new Set()));
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err && err.message || err}\n`);
  process.exitCode = 2;
});

/**
 * A self-contained, print-friendly HTML report. No external fonts, images or
 * scripts; the file can be emailed, archived or opened offline.
 */
const SEVERITY_LABEL = {
  critical: 'Critical',
  serious: 'Serious',
  moderate: 'Moderate',
  minor: 'Minor',
  advisory: 'Advisory',
};

const STATUS_COPY = {
  fail: 'Not ready to publish',
  review: 'Needs a manual review',
  pass: 'No automated blockers',
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch { return value; }
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 12)}…` : '';
}

function severityClass(severity) {
  return `severity-${escapeHtml(severity)}`;
}

function standards(standardsList) {
  return (standardsList || []).map((item) => `<span class="tag">${escapeHtml(item.name)} <span aria-hidden="true">·</span> ${escapeHtml(item.ref)}</span>`).join('');
}

function findingCard(finding, index) {
  const evidence = finding.evidence == null ? '' : `<pre class="evidence" tabindex="0" aria-label="Evidence">${escapeHtml(JSON.stringify(finding.evidence, null, 2))}</pre>`;
  return `<article class="finding" id="finding-${index}">
    <div class="finding-head">
      <span class="severity ${severityClass(finding.severity)}">${escapeHtml(SEVERITY_LABEL[finding.severity] || finding.severity)}</span>
      <h3>${escapeHtml(finding.title)}</h3>
      ${finding.page ? `<span class="page-ref">Page ${escapeHtml(finding.page)}</span>` : ''}
    </div>
    <p class="finding-message">${escapeHtml(finding.message)}</p>
    ${evidence}
    <div class="finding-grid">
      <div><p class="label">How to fix it</p><p>${escapeHtml(finding.remediation)}</p></div>
      <div><p class="label">Standards</p><div class="tags">${standards(finding.standards)}</div></div>
    </div>
    <p class="rule-id">Rule <code>${escapeHtml(finding.ruleId)}</code></p>
  </article>`;
}

function countCard(label, value, tone) {
  return `<div class="count ${tone}"><span class="count-value">${Number(value || 0)}</span><span class="count-label">${escapeHtml(label)}</span></div>`;
}

export function renderHtml(report) {
  const s = report.summary;
  const status = s.status || 'review';
  const score = Math.max(0, Math.min(100, Number(s.score || 0)));
  const rank = { critical: 0, serious: 1, moderate: 2, minor: 3, advisory: 4 };
  const top = [...report.findings]
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
    .slice(0, 5);
  const findings = report.findings.map(findingCard).join('');
  const checks = report.checks.map((check) => `<tr>
    <td>${escapeHtml(check.title)}<small>${escapeHtml(check.category)}</small></td>
    <td><span class="pill status-${escapeHtml(check.status)}">${escapeHtml(check.status)}</span>${check.reason ? `<small>${escapeHtml(check.reason)}</small>` : ''}</td>
  </tr>`).join('');
  const manual = report.manualChecks.map((check) => `<article class="manual">
    <div class="manual-mark" aria-hidden="true"></div>
    <div><h3>${escapeHtml(check.title)}</h3><p>${escapeHtml(check.summary)}</p><p class="guidance">${escapeHtml(check.guidance)}</p></div>
  </article>`).join('');
  const data = JSON.stringify(report).replace(/<\/script/gi, '<\\/script');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF accessibility audit — ${escapeHtml(report.file.name)}</title>
<meta name="robots" content="noindex, nofollow">
<style>
:root{
  --ink:#152033; --navy:#0c1f3a; --paper:#f5f1e8; --panel:#fffdf8; --panel-2:#fbf8f0;
  --line:#d9d2c2; --muted:#596274; --red:#b21f35; --red-bright:#e0243b;
  --green:#1d6a48; --amber:#8a5200; --critical:#a51f35; --serious:#8f4713;
  --moderate:#735500; --minor:#3f5368; --advisory:#637184;
  --radius:14px; --shadow:0 20px 50px rgba(12,31,58,.08);
  --header-bg:#0c1f3a; --header-ink:#f7f3e9;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--red)}
a:focus-visible,summary:focus-visible{outline:3px solid var(--red-bright);outline-offset:3px}
.skip{position:absolute;left:-999px;top:0;background:var(--navy);color:#fff;padding:12px 18px;z-index:10}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip:focus{left:12px;top:12px}
.site-header{background:var(--header-bg);color:var(--header-ink);padding:22px 28px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{display:flex;align-items:center;gap:12px;font-weight:650;letter-spacing:.01em}
.mark{display:inline-flex;width:30px;height:30px;align-items:center;justify-content:center;border-radius:8px;background:#0c1f3a;border:1px solid rgba(247,243,233,.22)}
.mark svg{width:22px;height:22px;display:block}
.header-meta{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c7d2df;text-align:right}
.wrap{max-width:1120px;margin:0 auto;padding:38px 24px 64px}
.hero{background:var(--panel);border:1px solid var(--line);border-top:5px solid var(--red);border-radius:var(--radius);padding:34px;box-shadow:var(--shadow)}
.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--red);font-weight:700;margin:0 0 8px}
h1,h2,h3{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:600;letter-spacing:-.015em;color:var(--navy)}
h1{font-size:clamp(30px,4vw,46px);line-height:1.08;margin:0 0 12px;overflow-wrap:anywhere}
.lede{color:var(--muted);margin:0;max-width:70ch}
.hero-grid{display:grid;grid-template-columns:minmax(260px,1fr) 2fr;gap:28px;margin-top:30px;align-items:stretch}
.score{display:flex;align-items:center;gap:20px;border-right:1px solid var(--line);padding-right:28px}
.score-ring{--pct:${score};width:104px;height:104px;border-radius:50%;background:conic-gradient(var(--navy) calc(var(--pct)*1%),#e7e1d4 0);display:grid;place-items:center;flex:0 0 auto;position:relative}
.score-ring::after{content:"";position:absolute;inset:9px;border-radius:50%;background:var(--panel)}
.score-ring span{position:relative;z-index:1;font:700 30px/1 ui-sans-serif,system-ui;color:var(--navy)}
.score-label{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
.score-note{margin:0;font-weight:650;color:var(--navy)}
.counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.count{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:2px;min-height:88px;justify-content:flex-end}
.count-value{font:700 26px/1 ui-sans-serif,system-ui;color:var(--navy)}
.count-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.count.critical{border-top:3px solid var(--critical)}.count.serious{border-top:3px solid var(--serious)}.count.moderate{border-top:3px solid var(--moderate)}.count.advisory{border-top:3px solid var(--advisory)}
.status{display:inline-flex;align-items:center;gap:8px;margin-top:18px;padding:7px 12px;border-radius:999px;font-size:13px;font-weight:650}
.status::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.status-fail{background:#f8e7e9;color:#8a1b2c}.status-review{background:#f8efdb;color:#6b4500}.status-pass{background:#e3f0e8;color:#16573a}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:30px;margin-top:26px}
.panel h2{font-size:28px;margin:0 0 6px}
.panel-intro{color:var(--muted);margin:0 0 22px;max-width:80ch}
.finding{border-top:1px solid var(--line);padding:22px 0 20px}
.finding:first-of-type{border-top:0;padding-top:0}
.finding-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.finding h3{font-size:22px;margin:0;flex:1 1 300px}
.severity{font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:750;padding:4px 8px;border-radius:5px;color:#fff;background:var(--advisory)}
.severity-critical{background:var(--critical)}.severity-serious{background:var(--serious)}.severity-moderate{background:var(--moderate)}.severity-minor{background:var(--minor)}.severity-advisory{background:var(--advisory)}
.page-ref{font-size:12px;color:var(--muted);white-space:nowrap}
.finding-message{margin:10px 0 12px;max-width:80ch}
.finding-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:24px;margin-top:14px}
.finding-grid p{margin:0 0 6px;max-width:75ch}
.label{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:4px 9px;background:var(--panel-2);color:var(--ink)}
.evidence{background:#f2eee3;border-left:3px solid var(--line);padding:12px 14px;border-radius:0 6px 6px 0;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:220px}
.rule-id{font-size:12px;color:var(--muted);margin:14px 0 0}
.rule-id code{background:var(--panel-2);padding:2px 5px;border-radius:3px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel)}
th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);background:var(--panel-2)}
tr:last-child td{border-bottom:0}
td small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.pill{display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
.status-pass{background:#e3f0e8;color:#16573a}.status-fail{background:#f8e7e9;color:#8a1b2c}.status-skipped{background:#ece8dd;color:#5a574e}
.manual{display:flex;gap:14px;border-top:1px solid var(--line);padding:18px 0}
.manual:first-child{border-top:0;padding-top:0}
.manual-mark{width:18px;height:18px;border:2px solid var(--navy);border-radius:4px;flex:0 0 auto;margin-top:3px}
.manual h3{font-size:19px;margin:0 0 4px}
.manual p{margin:0 0 4px;max-width:85ch}
.guidance{color:var(--muted);font-size:14px}
details{border-top:1px solid var(--line);padding-top:16px;margin-top:18px}
summary{cursor:pointer;font-weight:650;color:var(--navy)}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 30px;margin:0}
.facts div{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.facts dt{color:var(--muted);font-size:13px}.facts dd{margin:0;overflow-wrap:anywhere}
.footer{margin-top:34px;border-top:1px solid var(--line);padding-top:20px;color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
.footer strong{color:var(--navy)}
.empty{padding:20px;border:1px dashed var(--line);border-radius:10px;color:var(--muted)}
@media (max-width:760px){
  .site-header{padding:18px}.header-meta{display:none}.wrap{padding:22px 14px 44px}
  .hero,.panel{padding:22px}.hero-grid{grid-template-columns:1fr}.score{border-right:0;border-bottom:1px solid var(--line);padding:0 0 20px}
  .counts{grid-template-columns:repeat(2,minmax(0,1fr))}.finding-grid{grid-template-columns:1fr}
  .facts{grid-template-columns:1fr}.facts div{grid-template-columns:120px 1fr}
}
@media print{
  body{background:#fff}.site-header{background:#fff;color:#000;border-bottom:2px solid #000}
  .wrap{max-width:none;padding:0}.hero,.panel{box-shadow:none;border-color:#bbb;break-inside:avoid}
  .finding,.manual{break-inside:avoid}.footer{color:#000}
}
@media (prefers-color-scheme:dark){
  :root{--ink:#e8e4d8;--navy:#f4f0e5;--paper:#121820;--panel:#19212b;--panel-2:#202a35;--line:#33404e;--muted:#a9b3bf;--red:#ff7f8d;--red-bright:#ff9aa5;--green:#83d3a5;--amber:#f2c07a;--critical:#ff8b9a;--serious:#f0a36a;--moderate:#e6c56d;--minor:#b8c7d9;--advisory:#aab7c6;--shadow:0 20px 50px rgba(0,0,0,.3)}
  .evidence{background:#10161d}.status-fail{background:#3a1d23;color:#ffb6bf}.status-review{background:#3a301a;color:#f5d28b}.status-pass{background:#173528;color:#9fe0ba}
  .severity{color:#101820}
  .tag{background:#202a35}.score-ring::after{background:var(--panel)}
  :root{--header-bg:#0b1219;--header-ink:#f7f3e9}
}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to the report</a>
<header class="site-header">
  <div class="brand">
    <span class="mark" aria-hidden="true"><svg viewBox="0 0 32 32" role="img"><rect width="32" height="32" rx="9.5" fill="#0C1F3A"/><path d="M10 25V7" stroke="#E0243B" stroke-width="3.2" stroke-linecap="round"/><path d="M10 7h5.6a5 5 0 010 10H10" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M15.9 17 22 25" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg></span>
    <span>Remediate</span>
  </div>
  <div class="header-meta">PDF accessibility audit<br>Local report</div>
</header>
<main id="main" class="wrap">
  <section class="hero">
    <p class="eyebrow">Document audit · ${escapeHtml(formatDate(report.generatedAt))}</p>
    <h1>${escapeHtml(report.file.name)}</h1>
    <p class="lede">${report.document.pageCount} pages · ${formatBytes(report.file.bytes)} · SHA-256 ${escapeHtml(shortHash(report.file.sha256))}</p>
    <div class="hero-grid">
      <div class="score">
        <div class="score-ring" role="img" aria-label="Accessibility score ${score} out of 100"><span>${score}</span></div>
        <div><p class="score-label">Accessibility score</p><p class="score-note">${escapeHtml(STATUS_COPY[status] || status)}</p><span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span></div>
      </div>
      <div class="counts">
        ${countCard('Critical', s.critical, 'critical')}
        ${countCard('Serious', s.serious, 'serious')}
        ${countCard('Moderate', s.moderate, 'moderate')}
        ${countCard('Advisory', s.advisory, 'advisory')}
      </div>
    </div>
  </section>

  <section class="panel" aria-labelledby="first-heading">
    <h2 id="first-heading">What to fix first</h2>
    <p class="panel-intro">The highest-impact findings, ordered by severity. Each includes the evidence the audit found and the remediation step.</p>
    ${top.length ? top.map((finding, index) => findingCard(finding, `top-${index}`)).join('') : '<div class="empty">No automated findings. Continue with the manual checks below.</div>'}
  </section>

  <section class="panel" aria-labelledby="all-heading">
    <h2 id="all-heading">All findings</h2>
    <p class="panel-intro">${report.findings.length} automated finding${report.findings.length === 1 ? '' : 's'} across ${report.checks.filter((check) => check.status === 'fail').length} checks. Skipped checks are listed in the check register below.</p>
    ${findings || '<div class="empty">No automated findings.</div>'}
  </section>

  <section class="panel" aria-labelledby="manual-heading">
    <h2 id="manual-heading">Manual review required</h2>
    <p class="panel-intro">These are not automated passes. Complete them before calling the document accessible or publishing a conformance claim.</p>
    ${manual}
  </section>

  <section class="panel" aria-labelledby="facts-heading">
    <h2 id="facts-heading">Document facts</h2>
    <dl class="facts">
      <div><dt>Title</dt><dd>${escapeHtml(report.document.title || 'Missing')}</dd></div>
      <div><dt>Language</dt><dd>${escapeHtml(report.document.language || 'Missing')}</dd></div>
      <div><dt>Tagged</dt><dd>${report.document.tagged ? 'Yes' : 'No'}</dd></div>
      <div><dt>Marked content</dt><dd>${report.document.marked ? 'Yes' : 'No'}</dd></div>
      <div><dt>PDF/UA claim</dt><dd>${report.document.pdfuaClaim ? 'Yes' : 'No'}</dd></div>
      <div><dt>Display title</dt><dd>${report.document.displayDocTitle ? 'Yes' : 'No'}</dd></div>
      <div><dt>Pages</dt><dd>${report.document.pageCount}</dd></div>
      <div><dt>Scanned pages</dt><dd>${report.document.pagesScanned}</dd></div>
      <div><dt>Fonts</dt><dd>${report.document.fonts}</dd></div>
      <div><dt>Form fields</dt><dd>${report.document.formFields}</dd></div>
      <div><dt>Outline entries</dt><dd>${report.document.outlineEntries}</dd></div>
      <div><dt>Author</dt><dd>${escapeHtml(report.document.author || 'Not set')}</dd></div>
    </dl>
  </section>

  <section class="panel" aria-labelledby="checks-heading">
    <h2 id="checks-heading">Check register</h2>
    <p class="panel-intro">Every automated check, including the ones skipped because the document has no tag tree.</p>
    <details open>
      <summary>Show all ${report.checks.length} checks</summary>
      <div class="table-wrap" style="margin-top:14px" tabindex="0" role="region" aria-label="Automated check register">
        <table><caption class="sr-only">Automated checks</caption><thead><tr><th scope="col">Check</th><th scope="col">Status</th></tr></thead><tbody>${checks}</tbody></table>
      </div>
    </details>
  </section>

  <section class="panel" aria-labelledby="limits-heading">
    <h2 id="limits-heading">Method and limits</h2>
    <p class="panel-intro">This report was generated locally from the PDF object model and the PDF.js text layer. No document was uploaded.</p>
    <ul>
      ${report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
    </ul>
    <p class="rule-id">Generated by <strong>${escapeHtml(report.tool)} ${escapeHtml(report.version)}</strong> on ${escapeHtml(formatDate(report.generatedAt))}. ${report.checks.filter((check) => check.status === 'pass').length} checks passed, ${report.checks.filter((check) => check.status === 'fail').length} failed, ${report.checks.filter((check) => check.status === 'skipped').length} skipped.</p>
  </section>

  <footer class="footer">
    <span><strong>Remediate</strong> · PDF remediation and accessible publishing for public-sector teams.</span>
    <a href="https://remediatepdf.com/pdf-remediation?utm_source=pdf-a11y-audit&amp;utm_medium=html_report">Run this audit on your own documents</a>
  </footer>
</main>
<script type="application/json" id="audit-data">${data}</script>
</body>
</html>`;
}

export { escapeHtml };

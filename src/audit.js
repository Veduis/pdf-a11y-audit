/**
 * Deterministic audit orchestration and rule evaluation.
 */
import { loadPdf } from './pdf.js';
import { RULES, RULE_BY_ID, MANUAL_CHECKS, SEVERITY_WEIGHT } from '../rules/catalog.js';

const VERSION = '0.1.0';

function xmlDecode(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmpTitle(xmp) {
  const match = /<dc:title[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(String(xmp || ''));
  return match ? xmlDecode(match[1]).trim() : '';
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function elementText(element, doc, children, seen = new Set()) {
  if (!element || seen.has(element.id)) return '';
  seen.add(element.id);
  const parts = [];
  if (element.title) parts.push(element.title);
  if (element.alt) parts.push(element.alt);
  if (element.actualText) parts.push(element.actualText);
  const byPage = doc.mcidText && doc.mcidText.get(element.page);
  for (const mcid of element.mcids || []) {
    const text = byPage && byPage.get(mcid);
    if (text) parts.push(text);
  }
  for (const child of children.get(element.id) || []) {
    const text = elementText(child, doc, children, seen);
    if (text) parts.push(text);
  }
  return normalizeText(parts.filter(Boolean).join(' '));
}

function childrenMap(elements) {
  const map = new Map();
  for (const element of elements) {
    if (element.parentId == null) continue;
    if (!map.has(element.parentId)) map.set(element.parentId, []);
    map.get(element.parentId).push(element);
  }
  return map;
}

function descendants(element, children) {
  const out = [];
  const visit = (node) => {
    for (const child of children.get(node.id) || []) {
      out.push(child);
      visit(child);
    }
  };
  visit(element);
  return out;
}

function pageLabel(page) {
  return page == null ? '' : `page ${page}`;
}

export async function auditPdf(filePath, options = {}) {
  const doc = await loadPdf(filePath, options);
  const findings = [];
  const failedRules = new Set();
  const skipped = new Map();
  const evaluated = new Set();
  const children = childrenMap(doc.structure.elements);
  const maxFindings = Math.max(1, Number(options.maxFindings || 500));

  function add(ruleId, { page = null, message = '', evidence = null } = {}) {
    failedRules.add(ruleId);
    if (findings.length >= maxFindings) return;
    const rule = RULE_BY_ID.get(ruleId);
    if (!rule) throw new Error(`Unknown rule ${ruleId}`);
    findings.push({
      ruleId,
      title: rule.title,
      category: rule.category,
      severity: rule.severity,
      page,
      message: message || rule.summary,
      evidence: evidence == null ? null : evidence,
      remediation: rule.remediation,
      standards: rule.standards,
    });
    evaluated.add(ruleId);
  }

  function skip(ruleId, reason) {
    if (!skipped.has(ruleId)) skipped.set(ruleId, reason);
  }

  function evaluate(ruleId, fn) {
    if (skipped.has(ruleId)) return;
    fn();
    if (!failedRules.has(ruleId) && !skipped.has(ruleId)) evaluated.add(ruleId);
  }

  const tagged = !!doc.structure.present;
  const metadataTitle = normalizeText(doc.metadata.title);
  const xmp = doc.xmp || '';
  const xmpDocTitle = xmpTitle(xmp);
  const claimPdfua = /pdfuaid\s*:\s*part|pdfuaid:part|<pdfuaid:part/i.test(xmp);

  evaluate('pdfua.tagged', () => {
    if (!tagged) add('pdfua.tagged');
  });
  evaluate('pdfua.marked', () => {
    if (!doc.structure.marked) add('pdfua.marked');
  });
  evaluate('pdfua.parent-tree', () => {
    if (!tagged) { skip('pdfua.parent-tree', 'No structure tree.'); return; }
    if (!doc.structure.parentTree) add('pdfua.parent-tree');
  });
  evaluate('pdfua.suspects', () => {
    if (!tagged) { skip('pdfua.suspects', 'No structure tree.'); return; }
    if (doc.structure.suspects) add('pdfua.suspects');
  });
  evaluate('pdfua.rolemap', () => {
    if (!tagged) { skip('pdfua.rolemap', 'No structure tree.'); return; }
    const roles = [...doc.structure.customRoles];
    if (roles.length) add('pdfua.rolemap', { evidence: roles });
  });
  evaluate('pdfua.lang', () => {
    const lang = normalizeText(doc.language);
    if (!lang || !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i.test(lang)) add('pdfua.lang', { message: lang ? `Language tag "${lang}" is not a valid BCP 47 tag.` : 'The catalog has no /Lang value.' });
  });
  evaluate('pdfua.display-title', () => {
    if (!doc.displayDocTitle) add('pdfua.display-title');
  });
  evaluate('pdfua.title', () => {
    if (!metadataTitle) add('pdfua.title');
  });
  evaluate('pdfua.xmp-title', () => {
    if (!xmp) { add('pdfua.xmp-title', { message: 'The document has no XMP metadata stream.' }); return; }
    if (!xmpDocTitle) { add('pdfua.xmp-title', { message: 'The XMP metadata has no dc:title.' }); return; }
    if (metadataTitle && normalizeText(xmpDocTitle) !== metadataTitle) {
      add('pdfua.xmp-title', { message: 'The XMP title does not match the document information title.', evidence: { documentTitle: metadataTitle, xmpTitle: xmpDocTitle } });
    }
  });

  // Structural rules are only meaningful when the document has a tag tree.
  if (!tagged) {
    for (const id of [
      'headings.none', 'headings.first', 'headings.skipped', 'headings.empty', 'headings.multiple-h1',
      'tables.no-headers', 'tables.empty-header', 'tables.scope', 'tables.no-rows', 'tables.irregular',
      'figures.missing-alt', 'figures.empty-alt', 'figures.filename-alt',
      'lists.empty-item', 'links.struct-parent', 'links.name',
      'order.mcid-orphan', 'order.mcid-missing', 'order.mcid-order', 'order.untagged-text',
    ]) skip(id, 'No structure tree; structure-specific checks cannot run.');
  }

  evaluate('headings.none', () => {
    if (doc.structure.headings.length) return;
    if (doc.pageCount <= 2) {
      skip('headings.none', 'A short document may not need a heading hierarchy.');
      return;
    }
    add('headings.none');
  });
  evaluate('headings.first', () => {
    const first = doc.structure.headings[0];
    if (first && first.role !== 'H1') add('headings.first', { page: first.page, message: `The first heading is ${first.role}.` });
  });
  evaluate('headings.skipped', () => {
    let previous = 0;
    for (const heading of doc.structure.headings) {
      const level = Number(heading.role.slice(1));
      if (previous && level > previous + 1) {
        add('headings.skipped', { page: heading.page, message: `Heading level jumps from H${previous} to H${level}.`, evidence: { from: `H${previous}`, to: heading.role } });
      }
      previous = level;
    }
  });
  evaluate('headings.empty', () => {
    for (const heading of doc.structure.headings) {
      if (!elementText(heading, doc, children)) add('headings.empty', { page: heading.page, message: `${heading.role} has no text.` });
    }
  });
  evaluate('headings.multiple-h1', () => {
    const h1 = doc.structure.headings.filter((heading) => heading.role === 'H1');
    if (h1.length > 1) add('headings.multiple-h1', { evidence: { count: h1.length } });
  });

  evaluate('tables.no-headers', () => {
    for (const table of doc.structure.tables) {
      const cells = descendants(table, children);
      if (!cells.some((cell) => cell.role === 'TH')) add('tables.no-headers', { page: table.page });
    }
  });
  evaluate('tables.empty-header', () => {
    for (const table of doc.structure.tables) {
      for (const cell of descendants(table, children)) {
        if (cell.role !== 'TH') continue;
        if (!elementText(cell, doc, children)) add('tables.empty-header', { page: cell.page, message: 'A TH cell has no text.' });
      }
    }
  });
  evaluate('tables.scope', () => {
    for (const table of doc.structure.tables) {
      for (const cell of descendants(table, children)) {
        if (cell.role !== 'TH') continue;
        if (!cell.attributes.scope && !cell.attributes.headers) add('tables.scope', { page: cell.page, message: 'A TH cell has no Scope or Headers attribute.' });
      }
    }
  });
  evaluate('tables.no-rows', () => {
    for (const table of doc.structure.tables) {
      if (!descendants(table, children).some((cell) => cell.role === 'TR')) add('tables.no-rows', { page: table.page });
    }
  });
  evaluate('tables.irregular', () => {
    for (const table of doc.structure.tables) {
      const rows = descendants(table, children).filter((cell) => cell.role === 'TR');
      const counts = rows.map((row) => (children.get(row.id) || []).filter((cell) => cell.role === 'TH' || cell.role === 'TD').length).filter((count) => count > 0);
      if (counts.length > 1 && new Set(counts).size > 1) add('tables.irregular', { page: table.page, evidence: { rowCells: counts } });
    }
  });

  evaluate('figures.missing-alt', () => {
    for (const figure of doc.structure.figures) {
      if (!figure.hasAlt && !figure.hasActualText) add('figures.missing-alt', { page: figure.page, message: `${figure.role} has no alternative text.` });
    }
  });
  evaluate('figures.empty-alt', () => {
    for (const figure of doc.structure.figures) {
      if ((figure.hasAlt || figure.hasActualText) && !normalizeText(figure.alt)) add('figures.empty-alt', { page: figure.page, message: `${figure.role} has empty alternative text.` });
    }
  });
  evaluate('figures.filename-alt', () => {
    for (const figure of doc.structure.figures) {
      if (figure.alt && /\.(png|jpe?g|gif|webp|tiff?|bmp|svg)$/i.test(figure.alt)) add('figures.filename-alt', { page: figure.page, evidence: figure.alt });
    }
  });

  evaluate('forms.name', () => {
    for (const field of doc.fields) if (!normalizeText(field.name)) add('forms.name');
  });
  evaluate('forms.tooltip', () => {
    for (const field of doc.fields) if (!normalizeText(field.tooltip)) add('forms.tooltip', { evidence: field.name || '(unnamed field)' });
  });
  evaluate('forms.duplicate', () => {
    const names = new Map();
    for (const field of doc.fields) {
      const name = normalizeText(field.name);
      if (!name) continue;
      if (!names.has(name)) names.set(name, 0);
      names.set(name, names.get(name) + 1);
    }
    const duplicates = [...names.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (duplicates.length) add('forms.duplicate', { evidence: duplicates });
  });
  evaluate('forms.struct-parent', () => {
    if (!tagged) { skip('forms.struct-parent', 'No structure tree.'); return; }
    const widgets = doc.annotations.filter((annotation) => annotation.subtype === 'Widget');
    for (const widget of widgets) {
      if (widget.structParent == null) add('forms.struct-parent', { page: widget.page, message: 'A widget annotation has no /StructParent.' });
    }
  });
  evaluate('forms.tab-order', () => {
    const pagesWithWidgets = new Set(doc.annotations.filter((annotation) => annotation.subtype === 'Widget').map((annotation) => annotation.page));
    for (const page of pagesWithWidgets) {
      const info = doc.pages.find((entry) => entry.number === page);
      if (!info || info.tabs !== 'S') add('forms.tab-order', { page, message: 'The page does not set /Tabs /S.' });
    }
  });

  evaluate('lists.empty-item', () => {
    for (const list of doc.structure.lists) {
      const items = descendants(list, children).filter((element) => element.role === 'LI');
      for (const item of items) {
        const body = descendants(item, children).some((element) => element.role === 'LBody');
        if (!body) add('lists.empty-item', { page: item.page, message: 'A list item has no LBody.' });
      }
    }
  });

  evaluate('links.struct-parent', () => {
    const links = doc.annotations.filter((annotation) => annotation.subtype === 'Link');
    for (const link of links) if (link.structParent == null) add('links.struct-parent', { page: link.page, message: 'A link annotation has no /StructParent.' });
  });
  evaluate('links.name', () => {
    const links = doc.annotations.filter((annotation) => annotation.subtype === 'Link');
    for (const link of links) if (!normalizeText(link.contents)) add('links.name', { page: link.page, message: 'A link annotation has no accessible name.' });
  });

  evaluate('fonts.not-embedded', () => {
    if (!doc.fonts.length) { skip('fonts.not-embedded', 'No font resources found.'); return; }
    const missing = doc.fonts.filter((font) => !font.embedded).map((font) => font.base || font.subtype);
    if (missing.length) add('fonts.not-embedded', { evidence: [...new Set(missing)] });
  });
  evaluate('fonts.tounicode', () => {
    if (!doc.fonts.length) { skip('fonts.tounicode', 'No font resources found.'); return; }
    const missing = doc.fonts.filter((font) => !font.toUnicode).map((font) => font.base || font.subtype);
    if (missing.length) add('fonts.tounicode', { evidence: [...new Set(missing)] });
  });

  evaluate('pages.scanned', () => {
    for (const page of doc.pages) if (page.scanned) add('pages.scanned', { page: page.number, message: `Page ${page.number} has images but fewer than 20 characters of text.` });
  });
  evaluate('pages.blank', () => {
    for (const page of doc.pages) if (page.blank) add('pages.blank', { page: page.number });
  });
  evaluate('pages.sparse', () => {
    for (const page of doc.pages) if (page.sparse) add('pages.sparse', { page: page.number, evidence: { chars: page.chars } });
  });

  evaluate('order.mcid-orphan', () => {
    if (!tagged) return;
    for (const [page, contentMcids] of doc.mcidOrder) {
      const structural = new Set(doc.structure.mcidByPage.get(page) || []);
      const missing = contentMcids.filter((mcid) => !structural.has(mcid));
      if (missing.length) add('order.mcid-orphan', { page, evidence: { missing } });
    }
  });
  evaluate('order.mcid-missing', () => {
    if (!tagged) return;
    for (const [page, structuralMcids] of doc.structure.mcidByPage) {
      const content = new Set(doc.mcidOrder.get(page) || []);
      const missing = structuralMcids.filter((mcid) => !content.has(mcid));
      if (missing.length) add('order.mcid-missing', { page, evidence: { missing } });
    }
  });
  evaluate('order.mcid-order', () => {
    if (!tagged) return;
    for (const [page, structuralMcids] of doc.structure.mcidByPage) {
      const contentMcids = doc.mcidOrder.get(page) || [];
      const common = new Set(structuralMcids.filter((mcid) => contentMcids.includes(mcid)));
      const a = structuralMcids.filter((mcid) => common.has(mcid));
      const b = contentMcids.filter((mcid) => common.has(mcid));
      if (a.length > 1 && a.join(',') !== b.join(',')) add('order.mcid-order', { page, evidence: { structure: a, content: b } });
    }
  });
  evaluate('order.untagged-text', () => {
    if (!tagged) return;
    for (const page of doc.pages) {
      if (page.untaggedChars > 0) add('order.untagged-text', { page: page.number, evidence: { chars: page.untaggedChars } });
    }
  });

  evaluate('outline.missing', () => {
    if (doc.pageCount > 10 && !doc.outlineCount) add('outline.missing', { evidence: { pages: doc.pageCount } });
  });
  evaluate('outline.empty', () => {
    if (doc.outlineEmpty) add('outline.empty', { evidence: { emptyEntries: doc.outlineEmpty } });
  });

  evaluate('pdfua.pdfua-claim', () => {
    if (!claimPdfua) { skip('pdfua.pdfua-claim', 'No PDF/UA identifier in XMP.'); return; }
    const serious = [...failedRules].some((id) => {
      const severity = RULE_BY_ID.get(id) && RULE_BY_ID.get(id).severity;
      return severity === 'critical' || severity === 'serious';
    });
    if (serious) add('pdfua.pdfua-claim', { message: 'The file claims PDF/UA but has critical or serious findings.' });
  });

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, advisory: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  const failedSeverities = [...failedRules].map((id) => RULE_BY_ID.get(id) && RULE_BY_ID.get(id).severity).filter(Boolean);
  const penalty = findings.reduce((sum, finding) => sum + (SEVERITY_WEIGHT[finding.severity] || 0), 0);
  const score = Math.max(0, Math.round(100 - penalty));
  const status = failedSeverities.some((severity) => severity === 'critical' || severity === 'serious')
    ? 'fail'
    : failedSeverities.length ? 'review' : 'pass';

  const checks = RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    status: skipped.has(rule.id) ? 'skipped' : failedRules.has(rule.id) ? 'fail' : 'pass',
    reason: skipped.get(rule.id) || '',
  }));

  const pagesScanned = doc.pages.filter((page) => page.scanned).length;
  const structures = doc.structure.counts;
  return {
    tool: 'pdf-a11y-audit',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    file: { name: doc.fileName, bytes: doc.bytes, sha256: doc.sha256 },
    document: {
      pageCount: doc.pageCount,
      title: metadataTitle,
      author: normalizeText(doc.metadata.author),
      subject: normalizeText(doc.metadata.subject),
      keywords: normalizeText(doc.metadata.keywords),
      creator: normalizeText(doc.metadata.creator),
      producer: normalizeText(doc.metadata.producer),
      language: normalizeText(doc.language),
      displayDocTitle: doc.displayDocTitle,
      tagged,
      marked: doc.structure.marked,
      pdfuaClaim: claimPdfua,
      encrypted: doc.encrypted,
      pagesScanned,
      fonts: doc.fonts.length,
      formFields: doc.fields.length,
      annotations: doc.annotations.length,
      outlineEntries: doc.outlineCount,
      structure: {
        elements: doc.structure.elements.length,
        headings: doc.structure.headings.length,
        tables: doc.structure.tables.length,
        figures: doc.structure.figures.length,
        lists: doc.structure.lists.length,
        links: doc.structure.links.length,
        roles: structures,
      },
    },
    summary: { status, score, findings: findings.length, ...counts, checks: checks.length, skipped: checks.filter((check) => check.status === 'skipped').length, truncated: findings.length >= maxFindings },
    findings,
    checks,
    manualChecks: MANUAL_CHECKS.map((check) => ({ ...check, status: 'manual' })),
    limitations: [
      'Automated checks cannot certify conformance. Use the manual checks and a screen-reader pass before publishing.',
      'Colour contrast, alt-text quality and the meaning of the reading order require human review.',
      'The audit inspects the PDF file, not the customer website or third-party embeds.',
      'A missing finding is not proof of accessibility; malformed PDFs can hide structure from any parser.',
    ],
  };
}

export { VERSION };

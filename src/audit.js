/**
 * Deterministic audit orchestration, rule evaluation and triage scoring.
 *
 * The audit reports findings with evidence and remediation, then computes two
 * triage scores:
 *   blockingScore  100 - capped PDF/UA blocking penalties (critical/serious)
 *   polishScore    100 - capped quality penalties (moderate/advisory)
 *
 * Penalties are grouped per root cause and capped per rule, so a systemic
 * defect cannot auto-zero a document and the score does not depend on page
 * count or on how many findings the caller asked to display.
 */
import { readFileSync } from 'node:fs';
import { loadPdf, MAX_INSTANCES_PER_RULE } from './pdf.js';
import { RULES, RULE_BY_ID, MANUAL_CHECKS, SCORING, SEVERITY_WEIGHT } from '../rules/catalog.js';

// Read the version from the manifest instead of duplicating it here, so the
// CLI, the MCP serverInfo and every report stay in step with the release.
const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor', 'advisory'];
const SCORE_MODEL = 'triage-2';
const STRUCTURAL_RULES = new Set([
  'pdfua.marked', 'pdfua.parent-tree', 'pdfua.suspects', 'pdfua.rolemap',
  'struct.parent-entry', 'struct.heading-structure',
  'headings.none', 'headings.first', 'headings.skipped', 'headings.empty', 'headings.multiple-h1',
  'tables.no-headers', 'tables.empty-header', 'tables.scope', 'tables.no-rows', 'tables.irregular',
  'tables.syntax', 'tables.headers-resolution',
  'figures.missing-alt', 'figures.empty-alt', 'figures.filename-alt',
  'fields.accessible-name',
  'lists.empty-item', 'lists.listnumbering',
  'order.mcid-orphan', 'order.mcid-missing', 'order.mcid-order', 'order.untagged-text', 'order.artifact-nesting',
  'notes.id',
  'figures.untagged-images',
  'annotations.struct-parent',
]);

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
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

function pageLabel(page) {
  return page == null ? '' : `page ${page}`;
}

function buildFindings(recorder) {
  const findings = [];
  const failedRules = RULES.filter((rule) => recorder.failed.has(rule.id));
  const tierOf = (ruleId) => (SCORING[ruleId]?.tier || (ruleGlobalDefault(ruleId).tier));
  failedRules.sort((a, b) => {
    const tierDelta = tierRank(tierOf(a.id)) - tierRank(tierOf(b.id));
    if (tierDelta) return tierDelta;
    const severityDelta = severityRank(a.severity) - severityRank(b.severity);
    if (severityDelta) return severityDelta;
    return RULES.indexOf(a) - RULES.indexOf(b);
  });
  for (const rule of failedRules) {
    const stat = recorder.stats.get(rule.id);
    if (!stat) continue;
    const cfg = SCORING[rule.id] || ruleGlobalDefault(rule.id);
    const pages = [...stat.pages].sort((a, b) => a - b);
    if (cfg.aggregate && stat.occurrences > 1) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        page: pages[0] ?? null,
        message: `${stat.occurrences} occurrence${stat.occurrences === 1 ? '' : 's'}${pages.length ? ` across ${pages.length} page${pages.length === 1 ? '' : 's'}` : ''}.`,
        evidence: {
          occurrences: stat.occurrences,
          pages: pages.slice(0, 50),
          ...(stat.evidenceSample ? { sample: stat.evidenceSample } : {}),
        },
        remediation: rule.remediation,
        standards: rule.standards,
        occurrences: stat.occurrences,
      });
      continue;
    }
    const shown = stat.instances.slice(0, MAX_INSTANCES_PER_RULE);
    for (const instance of shown) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        tier: cfg.tier,
        page: instance.page ?? null,
        message: instance.message || rule.summary,
        evidence: instance.evidence == null ? null : instance.evidence,
        remediation: rule.remediation,
        standards: rule.standards,
        occurrences: 1,
      });
    }
    if (stat.occurrences > shown.length) {
      findings.push({
        ruleId: rule.id,
        title: `${rule.title} (more occurrences)`,
        category: rule.category,
        severity: rule.severity,
        tier: cfg.tier,
        page: null,
        message: `${stat.occurrences - shown.length} further occurrence${stat.occurrences - shown.length === 1 ? '' : 's'} not listed individually.`,
        evidence: { omitted: stat.occurrences - shown.length },
        remediation: rule.remediation,
        standards: rule.standards,
        occurrences: stat.occurrences - shown.length,
      });
    }
  }
  return findings;
}

function tierRank(tier) {
  return tier === 'blocking' ? 0 : tier === 'polish' ? 1 : 2;
}

function ruleGlobalDefault(ruleId) {
  const rule = RULE_BY_ID.get(ruleId);
  if (!rule) return { tier: 'info', weight: 0 };
  if (rule.severity === 'critical' || rule.severity === 'serious') return { tier: 'blocking', weight: 6, cap: 3 };
  if (rule.severity === 'moderate') return { tier: 'polish', weight: 3, cap: 3 };
  return { tier: 'polish', weight: 1, cap: 3 };
}

/** Capped, grouped, page-invariant penalties. */
function computeScores(recorder) {
  let blockingPenalty = 0;
  let polishPenalty = 0;
  const groupPenalties = new Map();
  const breakdown = [];
  for (const [ruleId, stat] of recorder.stats.entries()) {
    const cfg = SCORING[ruleId] || ruleGlobalDefault(ruleId);
    if (cfg.tier === 'info') {
      breakdown.push({ ruleId, tier: 'info', occurrences: stat.occurrences, penalty: 0 });
      continue;
    }
    const cap = Number.isFinite(cfg.cap) ? cfg.cap : 3;
    const effective = Math.min(stat.occurrences, cap);
    const penalty = (cfg.weight || 0) * effective;
    if (cfg.group) {
      const key = `${cfg.tier}:${cfg.group}`;
      groupPenalties.set(key, Math.max(groupPenalties.get(key) || 0, penalty));
      breakdown.push({ ruleId, tier: cfg.tier, occurrences: stat.occurrences, penalty: 0, group: cfg.group });
    } else {
      if (cfg.tier === 'blocking') blockingPenalty += penalty;
      else polishPenalty += penalty;
      breakdown.push({ ruleId, tier: cfg.tier, occurrences: stat.occurrences, penalty });
    }
  }
  for (const [key, penalty] of groupPenalties.entries()) {
    if (key.startsWith('blocking:')) blockingPenalty += penalty;
    else polishPenalty += penalty;
  }
  breakdown.sort((a, b) => Math.abs(b.penalty) - Math.abs(a.penalty));
  const blockingScore = Math.max(0, Math.min(100, 100 - blockingPenalty));
  let polishScore = Math.max(0, Math.min(100, 100 - polishPenalty));
  // Advisory findings must never round a report up to a perfect 100.
  if (polishPenalty > 0 && polishScore === 100) polishScore = 99;
  const status = blockingPenalty > 0 ? 'fail' : polishPenalty > 0 ? 'review' : 'pass';
  return { blockingPenalty, polishPenalty, blockingScore, polishScore, status, breakdown };
}

export async function auditPdf(filePath, options = {}) {
  const doc = await loadPdf(filePath, options);
  const children = childrenMap(doc.structure.elements);
  const maxFindings = Math.min(10000, Math.max(1, Number(options.maxFindings || 500)));
  const maxSeverityIndex = options.minSeverity ? SEVERITY_ORDER.indexOf(String(options.minSeverity)) : -1;

  const recorder = {
    stats: new Map(),
    failed: new Set(),
    skipped: new Map(),
    evaluated: new Set(),
  };

  function add(ruleId, { page = null, message = '', evidence = null } = {}) {
    const rule = RULE_BY_ID.get(ruleId);
    if (!rule) throw new Error(`Unknown rule ${ruleId}`);
    recorder.failed.add(ruleId);
    let stat = recorder.stats.get(ruleId);
    if (!stat) {
      stat = { occurrences: 0, pages: new Set(), instances: [], evidenceSample: null };
      recorder.stats.set(ruleId, stat);
    }
    stat.occurrences += 1;
    if (page != null) stat.pages.add(page);
    if (!stat.evidenceSample && evidence != null) stat.evidenceSample = evidence;
    if (stat.instances.length < MAX_INSTANCES_PER_RULE) {
      stat.instances.push({ page, message, evidence });
    }
  }

  function skip(ruleId, reason) {
    if (!recorder.skipped.has(ruleId)) recorder.skipped.set(ruleId, reason);
  }

  function evaluate(ruleId, fn) {
    if (recorder.skipped.has(ruleId)) return;
    fn();
    if (!recorder.failed.has(ruleId) && !recorder.skipped.has(ruleId)) recorder.evaluated.add(ruleId);
  }

  const tagged = !!doc.structure.present;
  const hasParentTree = tagged && doc.parentTree.present && doc.parentTree.byPage.size > 0;
  const metadataTitle = normalizeText(doc.metadata.title);
  const xmpTitle = normalizeText(doc.xmpTitle);
  const claimPdfua = !!doc.pdfuaClaim;
  const pageCount = doc.pageCount;

  // ---- Tagging / metadata -------------------------------------------------
  evaluate('pdfua.tagged', () => {
    if (!tagged) add('pdfua.tagged');
  });

  if (!tagged) {
    for (const id of STRUCTURAL_RULES) {
      skip(id, 'No structure tree; structure-specific checks cannot run.');
    }
  }

  evaluate('pdfua.marked', () => {
    if (!doc.structure.marked) add('pdfua.marked');
  });
  evaluate('pdfua.parent-tree', () => {
    if (!hasParentTree) add('pdfua.parent-tree', { message: 'The structure tree has no usable parent tree entries for its pages.' });
  });
  evaluate('pdfua.suspects', () => {
    if (doc.structure.suspects) add('pdfua.suspects');
  });
  evaluate('pdfua.rolemap', () => {
    const issues = doc.structure.roleMapIssues;
    const details = [
      ...issues.unmapped.map((role) => ({ kind: 'unmapped', role })),
      ...issues.circular.map((role) => ({ kind: 'circular', role })),
      ...issues.notStandard.map((role) => ({ kind: 'not-standard', role })),
      ...issues.remappedStandard.map((role) => ({ kind: 'standard-remapped', role })),
    ];
    if (details.length) add('pdfua.rolemap', { message: `${details.length} role-map issue${details.length === 1 ? '' : 's'}.`, evidence: details.slice(0, 20) });
  });
  evaluate('pdfua.lang', () => {
    const lang = normalizeText(doc.language);
    if (!lang && !doc.structure.elementLangCount) {
      add('pdfua.lang', { message: 'Neither the catalog nor the structure tree declares a language.' });
      return;
    }
    if (lang && !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i.test(lang)) {
      add('pdfua.lang', { message: `Language tag "${lang}" is not a valid BCP 47 tag.` });
    }
  });
  evaluate('pdfua.display-title', () => {
    if (!doc.displayDocTitle) add('pdfua.display-title');
  });
  evaluate('pdfua.title', () => {
    if (!metadataTitle) add('pdfua.title');
  });
  evaluate('pdfua.metadata-stream', () => {
    if (!doc.xmpPresent) { add('pdfua.metadata-stream', { message: 'The catalog has no /Metadata stream.' }); return; }
    if (!doc.xmpValid) add('pdfua.metadata-stream', { message: 'The metadata stream is not marked Type /Metadata and Subtype /XML.' });
  });
  evaluate('pdfua.xmp-title', () => {
    if (!doc.xmpPresent) { add('pdfua.xmp-title', { message: 'The document has no XMP metadata stream.' }); return; }
    if (!xmpTitle) add('pdfua.xmp-title', { message: 'The XMP metadata stream has no dc:title.' });
  });
  evaluate('pdfua.xmp-title-mismatch', () => {
    if (xmpTitle && metadataTitle && xmpTitle !== metadataTitle) {
      add('pdfua.xmp-title-mismatch', { message: 'The XMP dc:title and the document information title differ.', evidence: { documentTitle: metadataTitle, xmpTitle } });
    }
  });
  evaluate('pdfua.header', () => {
    if (!doc.headerVersion) add('pdfua.header', { message: 'No %PDF-1.x header was found in the first 1024 bytes.' });
  });
  evaluate('pdfua.encryption', () => {
    if (doc.encryption.encrypted && doc.encryption.allowsAccessibility === false) {
      add('pdfua.encryption', { message: 'The permission flags block content extraction for accessibility.' });
    }
  });
  evaluate('struct.parent-entry', () => {
    if (doc.structure.missingParent.length) {
      add('struct.parent-entry', { message: `${doc.structure.missingParent.length} structure element${doc.structure.missingParent.length === 1 ? '' : 's'} without a /P parent entry.`, evidence: { count: doc.structure.missingParent.length } });
    }
  });
  evaluate('struct.heading-structure', () => {
    const { generic, numbered } = doc.structure.headingTags;
    const mixed = generic > 0 && numbered > 0;
    let multipleHeadingChildren = 0;
    for (const [, kids] of children.entries()) {
      const headings = kids.filter((kid) => kid.role === 'H' || /^H[1-6]$/.test(kid.role));
      if (headings.length > 1) multipleHeadingChildren += 1;
    }
    if (mixed || multipleHeadingChildren) {
      add('struct.heading-structure', {
        message: [
          mixed ? 'The document mixes generic H tags with numbered H1-H6 tags.' : '',
          multipleHeadingChildren ? `${multipleHeadingChildren} node(s) contain more than one heading child.` : '',
        ].filter(Boolean).join(' '),
        evidence: { generic, numbered, multipleHeadingChildren },
      });
    }
  });

  // ---- Headings -----------------------------------------------------------
  evaluate('headings.none', () => {
    if (doc.structure.headings.length === 0 && doc.structure.headingTags.generic === 0) {
      if (pageCount <= 2) { skip('headings.none', 'A very short document may not need a heading hierarchy.'); return; }
      add('headings.none');
    }
  });
  evaluate('headings.first', () => {
    if (doc.structure.headingTags.generic > 0) { skip('headings.first', 'The document uses generic H headings; H1 order is not applicable.'); return; }
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
    for (const element of doc.structure.elements) {
      if (element.role === 'H' && !elementText(element, doc, children)) add('headings.empty', { page: element.page, message: 'Generic H has no text.' });
    }
  });
  evaluate('headings.multiple-h1', () => {
    const h1 = doc.structure.headings.filter((heading) => heading.role === 'H1');
    if (h1.length > 1) add('headings.multiple-h1', { evidence: { count: h1.length } });
  });

  // ---- Tables -------------------------------------------------------------
  function tableInfo(table) {
    const cells = descendants(table, children);
    const rows = cells.filter((cell) => cell.role === 'TR');
    const headerCells = cells.filter((cell) => cell.role === 'TH');
    const dataCells = cells.filter((cell) => cell.role === 'TD');
    const rowCells = new Map();
    for (const row of rows) rowCells.set(row.id, (children.get(row.id) || []).filter((kid) => kid.role === 'TH' || kid.role === 'TD'));
    return { cells, rows, headerCells, dataCells, rowCells };
  }

  function rowWidths(info) {
    return info.rows.map((row) => {
      const cells = info.rowCells.get(row.id) || [];
      return cells.reduce((sum, cell) => sum + (Number(cell.attributes.colSpan) || 1), 0);
    });
  }

  function tableDeterminable(info) {
    const thIds = new Set(info.headerCells.map((cell) => cell.idValue).filter(Boolean));
    const withHeaders = info.dataCells.filter((cell) => cell.attributes.headers.length);
    const allHeadersResolved = withHeaders.length === info.dataCells.length && info.dataCells.length > 0
      && withHeaders.every((cell) => cell.attributes.headers.every((id) => thIds.has(id)));
    if (thIds.size > 0 && allHeadersResolved) return true;
    // Simple grid: the first row is entirely TH, later rows have no TH and the
    // same effective width, so header association is unambiguous by algorithm.
    const firstRow = info.rows[0];
    if (!firstRow || !info.headerCells.length) return false;
    const firstCells = info.rowCells.get(firstRow.id) || [];
    if (!firstCells.length || firstCells.some((cell) => cell.role !== 'TH')) return false;
    const firstWidth = firstCells.reduce((sum, cell) => sum + (Number(cell.attributes.colSpan) || 1), 0);
    for (let index = 1; index < info.rows.length; index += 1) {
      const row = info.rows[index];
      const cells = info.rowCells.get(row.id) || [];
      if (!cells.length) continue;
      if (cells.some((cell) => cell.role === 'TH')) return false;
      const width = cells.reduce((sum, cell) => sum + (Number(cell.attributes.colSpan) || 1), 0);
      if (width !== firstWidth) return false;
    }
    return true;
  }

  for (const tableId of ['tables.no-headers', 'tables.empty-header', 'tables.scope', 'tables.no-rows', 'tables.irregular', 'tables.syntax', 'tables.headers-resolution']) {
    evaluate(tableId, () => {});
  }

  evaluate('tables.no-headers', () => {
    for (const table of doc.structure.tables) {
      if (String(table.attributes.owner).toLowerCase() === 'layout') continue;
      const info = tableInfo(table);
      if (info.rows.length && !info.headerCells.length) add('tables.no-headers', { page: table.page });
    }
  });
  evaluate('tables.empty-header', () => {
    for (const table of doc.structure.tables) {
      if (String(table.attributes.owner).toLowerCase() === 'layout') continue;
      for (const cell of tableInfo(table).headerCells) {
        if (!elementText(cell, doc, children)) add('tables.empty-header', { page: cell.page, message: 'A TH cell has no text.' });
      }
    }
  });
  evaluate('tables.scope', () => {
    for (const table of doc.structure.tables) {
      if (String(table.attributes.owner).toLowerCase() === 'layout') continue;
      const info = tableInfo(table);
      if (!info.rows.length || !info.headerCells.length) continue;
      if (tableDeterminable(info)) continue;
      for (const cell of info.headerCells) {
        if (!cell.attributes.scope) add('tables.scope', { page: cell.page, message: 'A TH cell has no Scope and the table has no usable Headers/ID association.' });
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
      if (String(table.attributes.owner).toLowerCase() === 'layout') continue;
      const info = tableInfo(table);
      if (!info.rows.length) continue;
      const widths = rowWidths(info).filter((width) => width > 0);
      if (widths.length > 1 && new Set(widths).size > 1) {
        add('tables.irregular', { page: table.page, evidence: { rowCells: widths } });
      }
    }
  });
  evaluate('tables.syntax', () => {
    for (const table of doc.structure.tables) {
      let violations = 0;
      for (const child of children.get(table.id) || []) {
        if (!['TR', 'THead', 'TBody', 'TFoot', 'Caption'].includes(child.role)) violations += 1;
      }
      for (const row of descendants(table, children).filter((cell) => cell.role === 'TR')) {
        for (const child of children.get(row.id) || []) {
          if (child.role !== 'TH' && child.role !== 'TD') violations += 1;
        }
      }
      for (const cell of descendants(table, children).filter((entry) => entry.role === 'TH' || entry.role === 'TD')) {
        const parent = cell.parentId != null ? doc.structure.elementById.get(cell.parentId) : null;
        if (!parent || parent.role !== 'TR') violations += 1;
      }
      if (violations) add('tables.syntax', { page: table.page, evidence: { violations } });
    }
  });
  evaluate('tables.headers-resolution', () => {
    for (const table of doc.structure.tables) {
      if (String(table.attributes.owner).toLowerCase() === 'layout') continue;
      const info = tableInfo(table);
      const thIds = new Set(info.headerCells.map((cell) => cell.idValue).filter(Boolean));
      let dangling = 0;
      for (const cell of info.dataCells) {
        for (const id of cell.attributes.headers) if (!thIds.has(id)) dangling += 1;
      }
      if (dangling) add('tables.headers-resolution', { page: table.page, message: `${dangling} TD Headers value${dangling === 1 ? '' : 's'} do not resolve to a TH /ID.`, evidence: { dangling } });
    }
  });

  // ---- Figures ------------------------------------------------------------
  evaluate('figures.missing-alt', () => {
    for (const figure of doc.structure.figures) {
      if (!figure.hasAlt && !figure.hasActualText) add('figures.missing-alt', { page: figure.page, message: `${figure.role} has no alternative text.` });
    }
  });
  evaluate('figures.empty-alt', () => {
    for (const figure of doc.structure.figures) {
      if ((figure.hasAlt || figure.hasActualText) && !normalizeText(figure.alt)) {
        add('figures.empty-alt', { page: figure.page, message: `${figure.role} has empty alternative text.` });
      }
    }
  });
  evaluate('figures.filename-alt', () => {
    for (const figure of doc.structure.figures) {
      if (figure.alt && /\.(png|jpe?g|gif|webp|tiff?|bmp|svg)$/i.test(figure.alt)) add('figures.filename-alt', { page: figure.page, evidence: figure.alt });
    }
  });

  // ---- Forms --------------------------------------------------------------
  evaluate('figures.empty-alt', () => {});
  evaluate('fields.accessible-name', () => {
    for (const field of doc.fields) {
      if (!field.terminal) continue;
      if (normalizeText(field.tooltip)) continue;
      if (field.altNames.some((alt) => normalizeText(alt))) continue;
      add('fields.accessible-name', { page: field.page, message: `Field "${field.fqName || field.name || '(unnamed)'}" has no /TU and no enclosing /Alt.` });
    }
  });
  evaluate('forms.name', () => {
    for (const field of doc.fields) if (field.terminal && !normalizeText(field.name)) add('forms.name');
  });
  evaluate('forms.duplicate', () => {
    const names = new Map();
    for (const field of doc.fields) {
      if (!field.terminal) continue;
      const name = normalizeText(field.fqName || field.name);
      if (!name) continue;
      names.set(name, (names.get(name) || 0) + 1);
    }
    const duplicates = [...names.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (duplicates.length) add('forms.duplicate', { evidence: duplicates });
  });
  evaluate('forms.struct-parent', () => {
    for (const annotation of doc.annotations) {
      if (annotation.subtype !== 'Widget') continue;
      const key = annotation.structParent;
      const resolved = key != null && doc.parentTree.byStructParent.has(String(key));
      if (!resolved) add('forms.struct-parent', { page: annotation.page, message: 'A widget annotation has no resolvable /StructParent entry.' });
    }
  });
  evaluate('pages.annotation-tabs', () => {
    for (const page of doc.pages) {
      if (page.annotations > 0 && page.tabs !== 'S') add('pages.annotation-tabs', { page: page.number, message: `Page ${page.number} has annotations but does not set /Tabs /S.` });
    }
  });

  // ---- Lists --------------------------------------------------------------
  evaluate('lists.empty-item', () => {
    for (const list of doc.structure.lists) {
      for (const item of descendants(list, children).filter((element) => element.role === 'LI')) {
        const body = descendants(item, children).some((element) => element.role === 'LBody');
        if (!body) add('lists.empty-item', { page: item.page, message: 'A list item has no LBody.' });
      }
    }
  });
  evaluate('lists.listnumbering', () => {
    for (const list of doc.structure.lists) {
      if (!list.attributes.listNumbering) add('lists.listnumbering', { page: list.page, message: 'An L element has no /ListNumbering attribute.' });
    }
  });

  // ---- Links --------------------------------------------------------------
  evaluate('links.struct-parent', () => {
    for (const annotation of doc.annotations) {
      if (annotation.subtype !== 'Link') continue;
      const key = annotation.structParent;
      const resolved = key != null && doc.parentTree.byStructParent.has(String(key));
      if (!resolved) add('links.struct-parent', { page: annotation.page, message: 'A link annotation has no resolvable /StructParent entry.' });
    }
  });
  evaluate('links.name', () => {
    for (const annotation of doc.annotations) {
      if (annotation.subtype !== 'Link') continue;
      if (!normalizeText(annotation.contents)) add('links.name', { page: annotation.page, message: 'A link annotation has no /Contents description.' });
    }
  });

  // ---- Fonts --------------------------------------------------------------
  evaluate('fonts.not-embedded', () => {
    if (!doc.fonts.length) { skip('fonts.not-embedded', 'No font resources found.'); return; }
    const missing = doc.fonts.filter((font) => !font.embedded && !font.exemptFromEmbedding).map((font) => font.base || font.subtype);
    if (missing.length) add('fonts.not-embedded', { evidence: [...new Set(missing)].slice(0, 30) });
  });
  evaluate('fonts.tounicode', () => {
    if (!doc.fonts.length) { skip('fonts.tounicode', 'No font resources found.'); return; }
    const missing = doc.fonts.filter((font) => !font.toUnicode && !font.exemptFromToUnicode).map((font) => font.base || font.subtype);
    if (missing.length) add('fonts.tounicode', { evidence: [...new Set(missing)].slice(0, 30) });
  });
  evaluate('fonts.tounicode-invalid', () => {
    const invalid = doc.fonts.filter((font) => font.toUnicodeInvalid).map((font) => font.base || font.subtype);
    if (invalid.length) add('fonts.tounicode-invalid', { evidence: [...new Set(invalid)].slice(0, 30) });
  });

  // ---- Pages and OCR ------------------------------------------------------
  evaluate('pages.scanned', () => {
    const scanned = doc.pages.filter((page) => page.scanned).map((page) => page.number);
    if (scanned.length) {
      add('pages.scanned', {
        page: scanned[0],
        message: `${scanned.length} page${scanned.length === 1 ? '' : 's'} have images but no usable text layer.`,
        evidence: { pages: scanned },
      });
    }
  });
  evaluate('pages.blank', () => {
    const blank = doc.pages.filter((page) => page.blank).map((page) => page.number);
    if (blank.length) add('pages.blank', { page: blank[0], message: `${blank.length} page${blank.length === 1 ? '' : 's'} appear blank.`, evidence: { pages: blank } });
  });
  evaluate('pages.sparse', () => {
    const sparse = doc.pages.filter((page) => page.sparse).map((page) => page.number);
    if (sparse.length) add('pages.sparse', { page: sparse[0], message: `${sparse.length} page${sparse.length === 1 ? '' : 's'} have very little text.`, evidence: { pages: sparse } });
  });

  // ---- Reading order ------------------------------------------------------
  evaluate('order.mcid-orphan', () => {
    if (!tagged) return;
    let orphanTotal = 0;
    let ignoredEmpty = 0;
    let heuristic = false;
    const orphanPages = new Set();
    for (let page = 1; page <= pageCount; page += 1) {
      const content = doc.contentByPage.get(page);
      if (!content) continue;
      const pageTree = doc.parentTree.byPage.get(page);
      const pagePrefix = doc.pagePrefixes && page + 1 ? `p${doc.pagePrefixes[page - 1]}R` : '';
      const structureMcids = new Set(doc.structure.mcidByPage.get(page) || []);
      for (const item of content.markedContent) {
        if (item.artifact) continue;
        if (item.hasContent === false) { ignoredEmpty += 1; continue; }
        let entries = null;
        if (item.prefix) entries = doc.parentTree.byStream.get(item.prefix) || null;
        if (!entries && pageTree && (!item.prefix || item.prefix === pagePrefix)) entries = pageTree.entries;
        if (!entries) {
          // No parent tree for this stream: fall back to the structure tree set.
          heuristic = true;
          if (!structureMcids.has(item.mcid)) { orphanTotal += 1; orphanPages.add(page); }
          continue;
        }
        const entry = entries.get(item.mcid);
        if (!entry) {
          orphanTotal += 1;
          orphanPages.add(page);
        }
      }
    }
    if (orphanTotal) {
      add('order.mcid-orphan', {
        page: [...orphanPages].sort((a, b) => a - b)[0],
        message: `${orphanTotal} marked-content item${orphanTotal === 1 ? ' is' : 's are'} neither tagged nor marked as an artifact${heuristic ? ' (heuristic; no parent tree entry was available for some streams)' : ''}.`,
        evidence: { occurrences: orphanTotal, pages: [...orphanPages].sort((a, b) => a - b).slice(0, 50), heuristic },
      });
    } else if (heuristic) {
      skip('order.mcid-orphan', 'No parent tree entries were available; the structure-tree fallback found no orphans.');
    } else if (ignoredEmpty > 0) {
      skip('order.mcid-orphan', `${ignoredEmpty} marked-content sequence(s) without extracted text were ignored; graphics-only content cannot be checked from the text layer.`);
    }
  });
  evaluate('order.mcid-missing', () => {
    if (!tagged) return;
    let missing = 0;
    const pages = [];
    for (const [page, mcids] of doc.structure.mcidByPage.entries()) {
      const contentMcids = new Set((doc.contentByPage.get(page)?.markedContent || []).map((item) => item.mcid));
      const absent = mcids.filter((mcid) => !contentMcids.has(mcid));
      if (absent.length) { missing += absent.length; pages.push(page); }
    }
    if (missing) add('order.mcid-missing', { message: `${missing} structure MCID reference${missing === 1 ? '' : 's'} were not present in the extracted text layer (graphics may be untagged).`, evidence: { pages: pages.slice(0, 50) } });
  });
  evaluate('order.mcid-order', () => {
    if (!tagged) return;
    for (const [page, structuralMcids] of doc.structure.mcidByPage.entries()) {
      const contentMcids = (doc.contentByPage.get(page)?.markedContent || []).map((item) => item.mcid);
      const common = new Set(structuralMcids.filter((mcid) => contentMcids.includes(mcid)));
      const a = structuralMcids.filter((mcid) => common.has(mcid));
      const b = contentMcids.filter((mcid) => common.has(mcid));
      if (a.length > 1 && a.join(',') !== b.join(',')) {
        add('order.mcid-order', { page, evidence: { structure: a.slice(0, 30), content: b.slice(0, 30) } });
        break;
      }
    }
  });
  evaluate('order.untagged-text', () => {
    const total = doc.pages.reduce((sum, page) => sum + (page.untaggedChars || 0), 0);
    if (total > 0) {
      const pages = doc.pages.filter((page) => page.untaggedChars > 0).map((page) => page.number);
      add('order.untagged-text', {
        page: pages[0],
        message: `${total} character${total === 1 ? '' : 's'} of text are outside marked content.`,
        evidence: { characters: total, pages: pages.slice(0, 50) },
      });
    }
  });
  evaluate('order.artifact-nesting', () => {
    const { artifactInTagged, taggedInArtifact } = doc.artifactNesting;
    if (artifactInTagged || taggedInArtifact) {
      add('order.artifact-nesting', {
        message: 'Marked-content sequences mix artifacts and tagged content.',
        evidence: { artifactsInsideTagged: artifactInTagged, taggedInsideArtifacts: taggedInArtifact },
      });
    }
  });

  // ---- Navigation ---------------------------------------------------------
  evaluate('outline.missing', () => {
    if (pageCount > 10 && !doc.outlineCount) add('outline.missing', { evidence: { pages: pageCount } });
  });
  evaluate('outline.empty', () => {
    if (doc.outlineEmpty) add('outline.empty', { evidence: { emptyEntries: doc.outlineEmpty } });
  });
  evaluate('figures.untagged-images', () => {
    if (doc.untaggedImages && doc.untaggedImages.count > 0) {
      add('figures.untagged-images', {
        page: doc.untaggedImages.pages[0] ?? null,
        message: `${doc.untaggedImages.count} image${doc.untaggedImages.count === 1 ? ' is' : 's are'} painted outside Figure/Formula or Artifact marked content.`,
        evidence: { occurrences: doc.untaggedImages.count, pages: doc.untaggedImages.pages.slice(0, 50) },
      });
    }
  });
  evaluate('annotations.struct-parent', () => {
    const exempt = new Set(['Widget', 'Link', 'PrinterMark', 'Popup', 'TrapNet']);
    for (const annotation of doc.annotations) {
      if (!annotation.subtype || exempt.has(annotation.subtype)) continue;
      const key = annotation.structParent;
      const resolved = key != null && doc.parentTree.byStructParent.has(String(key));
      if (!resolved) add('annotations.struct-parent', { page: annotation.page, message: `A ${annotation.subtype} annotation has no resolvable /StructParent entry.` });
    }
  });
  evaluate('annotations.trapnet', () => {
    for (const annotation of doc.annotations) {
      if (annotation.subtype === 'TrapNet') add('annotations.trapnet', { page: annotation.page });
    }
  });
  evaluate('pdfua.title-mismatch', () => {
    const title = normalizeText(metadataTitle || xmpTitle);
    const first = doc.structure.headings[0];
    if (!title || !first) return;
    const heading = elementText(first, doc, children);
    if (!heading) return;
    const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const normalizedTitle = normalize(title);
    const normalizedHeading = normalize(heading);
    if (normalizedTitle.length < 4 || normalizedHeading.length < 4) return;
    if (normalizedTitle === normalizedHeading) return;
    if (normalizedTitle.includes(normalizedHeading) || normalizedHeading.includes(normalizedTitle)) return;
    add('pdfua.title-mismatch', { message: `The title "${title}" and the first heading "${heading}" describe different things.`, evidence: { title, firstHeading: heading } });
  });
  evaluate('notes.id', () => {
    const ids = new Map();
    for (const note of doc.structure.notes) {
      const id = normalizeText(note.idValue);
      if (!id) add('notes.id', { page: note.page, message: 'A Note structure element has no /ID.' });
      else ids.set(id, (ids.get(id) || 0) + 1);
    }
    for (const [id, count] of ids.entries()) if (count > 1) add('notes.id', { message: `Note ID "${id}" is used ${count} times.` });
  });

  // ---- Document-level odds and ends --------------------------------------
  evaluate('xfa.dynamic', () => {
    if (doc.xfa.dynamic) add('xfa.dynamic');
  });
  evaluate('structure.reference-xobject', () => {
    if (doc.referenceXObjects > 0) add('structure.reference-xobject', { evidence: { count: doc.referenceXObjects } });
  });
  evaluate('pdfua.optional-content', () => {
    if (!doc.optionalContent.present) return;
    if (!doc.optionalContent.named || doc.optionalContent.hasAs) {
      add('pdfua.optional-content', { evidence: { named: doc.optionalContent.named, hasAs: doc.optionalContent.hasAs } });
    }
  });
  evaluate('pdfua.embedded-files', () => {
    if (doc.embeddedFiles.present && doc.embeddedFiles.missing.length) {
      add('pdfua.embedded-files', { evidence: { files: doc.embeddedFiles.count, missing: doc.embeddedFiles.missing.slice(0, 20) } });
    }
  });

  // ---- Report assembly ----------------------------------------------------
  const findings = buildFindings(recorder);
  const scores = computeScores(recorder);

  // The PDF/UA claim rule is evaluated last so it can see genuine findings.
  if (claimPdfua && scores.blockingPenalty > 0) {
    add('pdfua.pdfua-claim', { message: 'The file claims PDF/UA but fails machine-checkable requirements.' });
  }
  const finalFindings = buildFindings(recorder);

  const visibleFindings = maxSeverityIndex >= 0
    ? finalFindings.filter((finding) => severityRank(finding.severity) <= maxSeverityIndex)
    : finalFindings;
  const offset = Math.max(0, Number(options.offset || 0));
  const pageOfFindings = visibleFindings.slice(offset, offset + maxFindings);
  const returnedFindings = pageOfFindings;
  const severityCounts = { critical: 0, serious: 0, moderate: 0, minor: 0, advisory: 0 };
  let occurrences = 0;
  for (const finding of finalFindings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] || 0) + 1;
    occurrences += finding.occurrences || 1;
  }
  const checks = RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    tier: (SCORING[rule.id] || ruleGlobalDefault(rule.id)).tier,
    status: recorder.skipped.has(rule.id) ? 'skipped' : recorder.failed.has(rule.id) ? 'fail' : 'pass',
    reason: recorder.skipped.get(rule.id) || '',
  }));
  const passed = checks.filter((check) => check.status === 'pass').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skipped').length;
  const finalScores = claimPdfua && scores.blockingPenalty > 0
    ? computeScores(recorder)
    : scores;
  const status = finalScores.blockingPenalty > 0 ? 'fail' : finalScores.polishPenalty > 0 ? 'review' : 'pass';

  const pagesScanned = doc.pages.filter((page) => page.scanned).length;
  const structures = doc.structure.counts;
  return {
    tool: 'pdf-a11y-audit',
    version: VERSION,
    scoreModel: SCORE_MODEL,
    generatedAt: new Date().toISOString(),
    file: { name: doc.fileName, bytes: doc.bytes, sha256: doc.sha256 },
    document: {
      pageCount,
      title: metadataTitle,
      xmpTitle,
      author: normalizeText(doc.metadata.author),
      subject: normalizeText(doc.metadata.subject),
      keywords: normalizeText(doc.metadata.keywords),
      creator: normalizeText(doc.metadata.creator),
      producer: normalizeText(doc.metadata.producer),
      language: normalizeText(doc.language),
      displayDocTitle: doc.displayDocTitle,
      tagged,
      marked: doc.structure.marked,
      parentTree: hasParentTree,
      pdfuaClaim: claimPdfua,
      encrypted: doc.encrypted,
      accessibilityExtraction: doc.encryption.allowsAccessibility,
      headerVersion: doc.headerVersion,
      xmpPresent: doc.xmpPresent,
      xmpCompressed: doc.xmpCompressed,
      xfa: doc.xfa,
      optionalContent: doc.optionalContent,
      embeddedFiles: doc.embeddedFiles,
      referenceXObjects: doc.referenceXObjects,
      pagesScanned,
      fonts: doc.fonts.length,
      formFields: doc.fields.filter((field) => field.terminal).length,
      annotations: doc.annotations.length,
      outlineEntries: doc.outlineCount,
      structure: {
        elements: doc.structure.elements.length,
        headings: doc.structure.headings.length,
        tables: doc.structure.tables.length,
        figures: doc.structure.figures.length,
        forms: doc.structure.formElements.length,
        lists: doc.structure.lists.length,
        links: doc.structure.links.length,
        roles: structures,
      },
    },
    summary: {
      status,
      score: finalScores.blockingScore,
      blockingScore: finalScores.blockingScore,
      polishScore: finalScores.polishScore,
      blockingPenalty: finalScores.blockingPenalty,
      polishPenalty: finalScores.polishPenalty,
      findings: finalFindings.length,
      occurrences,
      returnedFindings: returnedFindings.length,
      ...severityCounts,
      checks: checks.length,
      passed,
      failed,
      skipped,
      truncated: offset + returnedFindings.length < visibleFindings.length,
      offset,
      filtered: maxSeverityIndex >= 0,
      scoreModel: SCORE_MODEL,
    },
    scoreBreakdown: finalScores.breakdown,
    findings: returnedFindings,
    checks,
    manualChecks: MANUAL_CHECKS.map((check) => ({ ...check, status: 'manual' })),
    limitations: [
      'Automated checks cannot certify conformance, and the triage scores are not PDF/UA conformance scores.',
      'This is a heuristic triage tool, not a PDF/UA validator. Use veraPDF or PAC plus a screen reader for conformance decisions.',
      'Colour contrast, alt-text quality, OCR accuracy and the meaning of the reading order require human review.',
      'The audit inspects the PDF file, not the customer website or third-party embeds.',
      'A missing finding is not proof of accessibility; malformed PDFs can hide structure from any parser.',
    ],
  };
}

export function findingFingerprint(finding) {
  const evidence = finding && finding.evidence != null ? JSON.stringify(finding.evidence) : '';
  return [finding.ruleId || '', finding.page || 0, evidence].join('|');
}

export { VERSION, SEVERITY_WEIGHT, computeScores };

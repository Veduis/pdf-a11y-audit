/**
 * PDF loading and structure extraction.
 *
 * pdf-lib gives us the object model (structure tree, parent tree, fonts, forms,
 * annotations, metadata, permissions). PDF.js gives us text extraction and the
 * marked-content sequence. Both are local and deterministic; no document ever
 * leaves the machine.
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString, PDFNumber } from 'pdf-lib';

function isNullish(value) {
  return value == null || (value && value.constructor && value.constructor.name === 'PDFNull');
}
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const STANDARD_ROLES = new Set([
  'Document', 'Part', 'Sect', 'Div', 'Aside', 'Art', 'BlockQuote', 'Caption',
  'TOC', 'TOCI', 'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD',
  'THead', 'TBody', 'TFoot', 'Span', 'Quote', 'Note', 'Reference', 'BibEntry',
  'Code', 'Link', 'Annot', 'Figure', 'Formula', 'Form', 'Ruby', 'Warichu',
  'WT', 'WP', 'Artifact',
]);

const HEADING_ROLES = new Set(['H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const FIGURE_ROLES = new Set(['Figure', 'Formula']);
const TABLE_CHILD_ROLES = new Set(['TR', 'THead', 'TBody', 'TFoot', 'Caption']);
const TABLE_ROW_CELL_ROLES = new Set(['TH', 'TD']);
const PREDEFINED_UNICODE_ENCODINGS = new Set(['WinAnsiEncoding', 'MacRomanEncoding', 'MacExpertEncoding']);
const MAX_INSTANCES_PER_RULE = 25;

function asDict(ctx, value) {
  if (!value) return null;
  if (value instanceof PDFRef) value = ctx.lookup(value);
  if (value instanceof PDFStream) return value.dict;
  return value instanceof PDFDict ? value : null;
}

function lookup(ctx, dict, key) {
  const obj = asDict(ctx, dict);
  if (!obj) return undefined;
  try { return obj.lookup(PDFName.of(key)); } catch { return undefined; }
}

function nameOf(value) {
  if (!(value instanceof PDFName)) return '';
  try { return value.asString().replace(/^\//, ''); } catch { return ''; }
}

function numberOf(value) {
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function textOf(value) {
  if (!value) return '';
  try {
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
    if (value instanceof PDFName) return value.asString().replace(/^\//, '');
  } catch { return ''; }
  return '';
}

function boolOf(value) {
  try { return !!(value && value.asBoolean && value.asBoolean()); } catch { return false; }
}

function refKey(ref) {
  return ref instanceof PDFRef ? `${ref.objectNumber}g${ref.generationNumber}` : '';
}

/** Resolve a value but never run through a page/resource tree. */
function resolveValue(ctx, value) {
  if (!value) return undefined;
  if (value instanceof PDFRef) {
    try { return ctx.lookup(value); } catch { return undefined; }
  }
  return value;
}

/** Raw array entries (references preserved), unlike arrayOf below. */
function rawArray(ctx, value) {
  if (!value) return [];
  if (value instanceof PDFRef) value = resolveValue(ctx, value);
  if (value instanceof PDFArray) return value.asArray();
  if (Array.isArray(value)) return value;
  return [value];
}

function arrayOf(ctx, value) {
  return rawArray(ctx, value).map((item) => resolveValue(ctx, item));
}

/** Expand nested arrays (AcroForm /Kids and /Fields are often nested arrays). */
function flattenNodes(ctx, value, out = []) {
  for (const entry of rawArray(ctx, value)) {
    const resolved = resolveValue(ctx, entry);
    if (resolved instanceof PDFArray) flattenNodes(ctx, resolved, out);
    else if (!isNullish(resolved)) out.push(entry);
  }
  return out;
}

function dictOfValue(ctx, value) {
  const resolved = resolveValue(ctx, value);
  const dict = asDict(ctx, resolved);
  return dict || null;
}

function pageNumberFor(ctx, value, pageByRef, pageByNode, fallback = null) {
  if (value instanceof PDFRef) return pageByRef.get(refKey(value)) || fallback;
  const dict = asDict(ctx, value);
  if (dict && pageByNode.has(dict)) return pageByNode.get(dict);
  return fallback;
}

/** Decode a stream's contents, inflating FlateDecode (used for XMP/XFA/ToUnicode). */
function streamBytesText(ctx, stream) {
  if (!stream) return { text: '', compressed: false };
  try {
    const dict = stream.dict || (stream instanceof PDFDict ? stream : null);
    const filterValue = dict ? resolveValue(ctx, dict.get(PDFName.of('Filter'))) : undefined;
    const filters = [];
    if (filterValue instanceof PDFName) filters.push(nameOf(filterValue));
    else if (filterValue instanceof PDFArray) filters.push(...filterValue.asArray().map((entry) => nameOf(resolveValue(ctx, entry))));
    const contents = stream.contents || (typeof stream.getContents === 'function' ? stream.getContents() : null);
    let bytes = contents instanceof Uint8Array ? Buffer.from(contents) : null;
    let compressed = false;
    if (bytes && filters.includes('FlateDecode')) {
      try { bytes = zlib.inflateSync(bytes); compressed = true; } catch { /* leave raw */ }
    }
    if (!bytes) {
      const raw = stream.getContentsString ? stream.getContentsString() : '';
      return { text: raw, compressed };
    }
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), compressed };
  } catch {
    return { text: '', compressed: false };
  }
}

function streamOf(ctx, value) {
  const resolved = resolveValue(ctx, value);
  return resolved instanceof PDFStream ? resolved : null;
}

function parseAttributes(ctx, value) {
  const out = { scope: '', headers: [], owner: '', id: '', listNumbering: '', colSpan: 1, rowSpan: 1 };
  for (const item of rawArray(ctx, value)) {
    const dict = dictOfValue(ctx, item);
    if (!dict) continue;
    const scope = nameOf(lookup(ctx, dict, 'Scope'));
    const headers = arrayOf(ctx, lookup(ctx, dict, 'Headers')).map((entry) => textOf(entry)).filter(Boolean);
    const owner = nameOf(lookup(ctx, dict, 'O'));
    const id = textOf(lookup(ctx, dict, 'ID'));
    const listNumbering = nameOf(lookup(ctx, dict, 'ListNumbering'));
    const colSpan = numberOf(resolveValue(ctx, lookup(ctx, dict, 'ColSpan')));
    const rowSpan = numberOf(resolveValue(ctx, lookup(ctx, dict, 'RowSpan')));
    if (colSpan && colSpan > 1) out.colSpan = colSpan;
    if (rowSpan && rowSpan > 1) out.rowSpan = rowSpan;
    if (scope) out.scope = scope;
    if (headers.length) out.headers = headers;
    if (owner) out.owner = owner;
    if (id) out.id = id;
    if (listNumbering) out.listNumbering = listNumbering;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure tree
// ---------------------------------------------------------------------------

function parseStructure(doc) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const pageByRef = new Map(pages.map((page, index) => [refKey(page.ref), index + 1]));
  const pageByNode = new Map(pages.map((page, index) => [page.node, index + 1]));
  const root = asDict(ctx, lookup(ctx, doc.catalog, 'StructTreeRoot'));
  const result = {
    present: !!root,
    marked: boolOf(lookup(ctx, asDict(ctx, lookup(ctx, doc.catalog, 'MarkInfo')), 'Marked')),
    parentTreePresent: false,
    suspects: boolOf(root && lookup(ctx, root, 'Suspects')),
    roleMap: new Map(),
    roleMapIssues: { unmapped: [], circular: [], notStandard: [], remappedStandard: [] },
    customRolesUsed: new Set(),
    elements: [],
    headings: [],
    tables: [],
    figures: [],
    formElements: [],
    lists: [],
    links: [],
    notes: [],
    counts: {},
    mcidByPage: new Map(),
    headingTags: { generic: 0, numbered: 0 },
    missingParent: [],
    elementLangCount: 0,
    elementById: new Map(),
    elementByRef: new Map(),
    rootPresent: !!root,
  };
  if (!root) return result;

  const roleMap = asDict(ctx, lookup(ctx, root, 'RoleMap'));
  if (roleMap) {
    for (const [key, value] of roleMap.entries()) {
      const from = nameOf(key);
      const to = nameOf(resolveValue(ctx, value));
      if (from && to) result.roleMap.set(from, to);
    }
  }

  function resolveRole(role) {
    let current = role;
    const seen = new Set();
    while (result.roleMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = result.roleMap.get(current);
    }
    return current;
  }

  let id = 0;
  function collectMcid(page, mcid) {
    if (page == null || mcid == null) return;
    if (!result.mcidByPage.has(page)) result.mcidByPage.set(page, []);
    result.mcidByPage.get(page).push(String(mcid));
  }

  function walk(value, context, parentRefKey) {
    if (value === null || value === undefined) return;
    if (value instanceof PDFNumber || typeof value === 'number') {
      const number = value instanceof PDFNumber ? value.asNumber() : Number(value);
      collectMcid(context.page, number);
      if (context.mcids) context.mcids.push(String(number));
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, context, parentRefKey); return; }
    if (value instanceof PDFArray) { for (const item of value.asArray()) walk(item, context, parentRefKey); return; }

    const originalRef = value instanceof PDFRef ? value : null;
    const dict = asDict(ctx, value);
    if (!dict) return;

    const type = nameOf(lookup(ctx, dict, 'Type'));
    const page = pageNumberFor(ctx, lookup(ctx, dict, 'Pg'), pageByRef, pageByNode, context.page);
    const mcid = numberOf(lookup(ctx, dict, 'MCID'));
    if (mcid != null) {
      collectMcid(page, mcid);
      if (context.mcids) context.mcids.push(String(mcid));
      return;
    }
    if (type === 'MCR') {
      collectMcid(page, mcid);
      return;
    }
    if (type === 'OBJR') return;

    const rawRole = nameOf(lookup(ctx, dict, 'S'));
    const role = rawRole ? resolveRole(rawRole) : '';
    if (rawRole && !STANDARD_ROLES.has(rawRole) && !result.roleMap.has(rawRole)) result.customRolesUsed.add(rawRole);

    const directId = textOf(lookup(ctx, dict, 'ID'));
    const attributes = parseAttributes(ctx, lookup(ctx, dict, 'A'));
    const alt = textOf(lookup(ctx, dict, 'Alt')) || textOf(lookup(ctx, dict, 'ActualText'));
    const element = {
      id: id++,
      role,
      rawRole,
      page,
      depth: context.depth,
      parentId: context.parentId,
      hasParent: lookup(ctx, dict, 'P') != null,
      hasAlt: lookup(ctx, dict, 'Alt') != null,
      hasActualText: lookup(ctx, dict, 'ActualText') != null,
      alt,
      actualText: textOf(lookup(ctx, dict, 'ActualText')),
      title: textOf(lookup(ctx, dict, 'T')),
      lang: textOf(lookup(ctx, dict, 'Lang')),
      idValue: directId || attributes.id,
      attributes,
      mcids: [],
    };

    if (role) {
      result.elements.push(element);
      result.elementById.set(element.id, element);
      if (originalRef) result.elementByRef.set(refKey(originalRef), element.id);
      if (role === 'H') result.headingTags.generic += 1;
      if (/^H[1-6]$/.test(role)) { result.headings.push(element); result.headingTags.numbered += 1; }
      if (role === 'Table') result.tables.push(element);
      if (FIGURE_ROLES.has(role)) result.figures.push(element);
      if (role === 'Form') result.formElements.push(element);
      if (role === 'L') result.lists.push(element);
      if (role === 'Link') result.links.push(element);
      if (role === 'Note') result.notes.push(element);
      if (element.lang) result.elementLangCount += 1;
      if (!element.hasParent) result.missingParent.push(element.id);
      result.counts[role] = (result.counts[role] || 0) + 1;
    }

    const kids = lookup(ctx, dict, 'K');
    if (kids) {
      const childMcids = [];
      walk(kids, { page, depth: context.depth + 1, parentId: role ? element.id : context.parentId, mcids: childMcids }, originalRef ? refKey(originalRef) : parentRefKey);
      element.mcids = childMcids;
    }
  }

  walk(lookup(ctx, root, 'K'), { page: 1, depth: 1, parentId: null, mcids: null }, '');
  result.present = true;

  // RoleMap integrity (veraPDF 7.1-5/6/7).
  for (const [from, to] of result.roleMap.entries()) {
    if (STANDARD_ROLES.has(from)) { result.roleMapIssues.remappedStandard.push(from); continue; }
    const seen = new Set([from]);
    let current = to;
    while (result.roleMap.has(current)) {
      if (seen.has(current)) { result.roleMapIssues.circular.push(from); break; }
      seen.add(current);
      current = result.roleMap.get(current);
    }
    if (!STANDARD_ROLES.has(current) && !result.roleMapIssues.circular.includes(from)) {
      result.roleMapIssues.notStandard.push(`${from}->${current}`);
    }
  }
  for (const role of result.customRolesUsed) {
    if (!result.roleMap.has(role) && !result.roleMapIssues.unmapped.includes(role)) result.roleMapIssues.unmapped.push(role);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Parent tree (the authority for MCIDs and widget ownership)
// ---------------------------------------------------------------------------

function collectNumberTree(ctx, node, out) {
  const dict = asDict(ctx, node);
  if (!dict) return;
  const nums = lookup(ctx, dict, 'Nums');
  if (nums) {
    const entries = rawArray(ctx, nums);
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const key = numberOf(resolveValue(ctx, entries[index]));
      if (key == null) continue;
      out.set(String(key), entries[index + 1]);
    }
  }
  const kids = lookup(ctx, dict, 'Kids');
  if (kids) for (const kid of rawArray(ctx, kids)) collectNumberTree(ctx, kid, out);
}

function parseParentTree(doc, structure) {
  const ctx = doc.context;
  const root = asDict(ctx, lookup(ctx, doc.catalog, 'StructTreeRoot'));
  const result = {
    present: false,
    raw: new Map(),
    byPage: new Map(),
    byKey: new Map(),
    byStream: new Map(),
    byStructParent: new Map(),
    unresolvedEntries: 0,
  };
  if (!root) return result;
  const tree = lookup(ctx, root, 'ParentTree');
  if (!tree) return result;
  collectNumberTree(ctx, tree, result.raw);
  result.present = result.raw.size > 0;

  function resolveStructElem(value) {
    let resolved = resolveValue(ctx, value);
    if (isNullish(resolved)) return null;
    if (resolved instanceof PDFArray) {
      const first = resolved.asArray().map((entry) => resolveValue(ctx, entry)).find(Boolean);
      if (!first) return null;
      resolved = first;
    }
    const dict = asDict(ctx, resolved);
    if (!dict) return null;
    const ref = value instanceof PDFRef ? value : (resolved instanceof PDFRef ? resolved : null);
    const elementId = (ref && structure.elementByRef.get(refKey(ref)) != null)
      ? structure.elementByRef.get(refKey(ref))
      : null;
    const alt = textOf(lookup(ctx, dict, 'Alt')) || textOf(lookup(ctx, dict, 'ActualText'));
    return {
      role: nameOf(lookup(ctx, dict, 'S')),
      elementId,
      alt,
      actualText: textOf(lookup(ctx, dict, 'ActualText')),
    };
  }

  function entriesFromValue(value) {
    const map = new Map();
    const resolved = resolveValue(ctx, value);
    if (!resolved) return null;
    if (resolved instanceof PDFArray) {
      const entries = resolved.asArray();
      for (let index = 0; index < entries.length; index += 1) {
        const entry = resolveStructElem(entries[index]);
        if (entry) map.set(String(index), entry);
        else result.unresolvedEntries += 1;
      }
      return map;
    }
    if (resolved instanceof PDFDict) {
      // A nested number tree keyed by MCID.
      const nested = new Map();
      collectNumberTree(ctx, resolved, nested);
      if (!nested.size) return null;
      for (const [key, entryValue] of nested.entries()) {
        const entry = resolveStructElem(entryValue);
        if (entry) map.set(String(key), entry);
        else result.unresolvedEntries += 1;
      }
      return map;
    }
    const single = resolveStructElem(value);
    if (single) map.set('0', single);
    return map.size ? map : null;
  }

  const pages = doc.getPages();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const structParents = numberOf(lookup(ctx, page.node, 'StructParents'));
    if (structParents == null) continue;
    const value = result.raw.get(String(structParents));
    if (!value) continue;
    const entries = entriesFromValue(value);
    if (entries) {
      result.byPage.set(index + 1, { key: String(structParents), entries });
      result.byKey.set(String(structParents), entries);
    }
  }

  // Widgets and other annotations carry a single /StructParent key.
  for (const page of pages) {
    const annots = arrayOf(ctx, lookup(ctx, page.node, 'Annots'));
    for (const annot of annots) {
      const dict = asDict(ctx, annot);
      if (!dict) continue;
      const key = numberOf(lookup(ctx, dict, 'StructParent'));
      if (key == null) continue;
      const value = result.raw.get(String(key));
      if (!value) continue;
      const entry = resolveStructElem(value);
      if (entry) result.byStructParent.set(String(key), entry);
    }
  }
  return result;
}

/** Build stream-prefix -> parent-tree entry map for page and XObject content. */
function parseStreamParentTrees(doc, parentTree) {
  const ctx = doc.context;
  const byStream = new Map();

  function addStream(prefix, structParents) {
    if (!prefix || byStream.has(prefix) || structParents == null) return;
    const entries = parentTree.byKey.get(String(structParents));
    if (entries) byStream.set(prefix, entries);
  }

  const queue = [];
  for (let index = 0; index < doc.getPages().length; index += 1) {
    const page = doc.getPages()[index];
    addStream(`p${page.ref.objectNumber}R`, numberOf(lookup(ctx, page.node, 'StructParents')));
    queue.push({ resources: page.node.Resources ? page.node.Resources() : null, depth: 0 });
  }
  while (queue.length) {
    const { resources, depth } = queue.pop();
    if (!resources || depth > 3) continue;
    const xObjects = asDict(ctx, lookup(ctx, resources, 'XObject'));
    if (!xObjects) continue;
    for (const [, value] of xObjects.entries()) {
      const stream = streamOf(ctx, value);
      if (!stream) continue;
      const ref = value instanceof PDFRef ? value : null;
      if (ref) addStream(`p${ref.objectNumber}R`, numberOf(lookup(ctx, stream.dict, 'StructParents')));
      if (nameOf(lookup(ctx, stream.dict, 'Subtype')) === 'Form') {
        queue.push({ resources: lookup(ctx, stream.dict, 'Resources'), depth: depth + 1 });
      }
    }
  }
  return byStream;
}

// ---------------------------------------------------------------------------
// Fonts, forms, annotations, page details
// ---------------------------------------------------------------------------

function parseFonts(ctx, doc) {
  const fonts = new Map();
  function consider(value) {
    const dict = dictOfValue(ctx, value);
    if (!dict) return;
    const base = textOf(lookup(ctx, dict, 'BaseFont'));
    const subtype = nameOf(lookup(ctx, dict, 'Subtype'));
    const descriptor = dictOfValue(ctx, lookup(ctx, dict, 'FontDescriptor'));
    let embedded = !!descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => !!lookup(ctx, descriptor, key));
    if (subtype === 'Type0') {
      for (const descendant of arrayOf(ctx, lookup(ctx, dict, 'DescendantFonts'))) {
        const d = asDict(ctx, descendant);
        if (!d) continue;
        const dd = dictOfValue(ctx, lookup(ctx, d, 'FontDescriptor'));
        if (dd && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => !!lookup(ctx, dd, key))) embedded = true;
      }
    }
    const encodingValue = resolveValue(ctx, lookup(ctx, dict, 'Encoding'));
    let encoding = nameOf(encodingValue);
    if (!encoding) {
      const encodingDict = asDict(ctx, encodingValue);
      if (encodingDict) encoding = nameOf(lookup(ctx, encodingDict, 'BaseEncoding'));
    }
    let toUnicodeInvalid = false;
    const toUnicodeStream = streamOf(ctx, lookup(ctx, dict, 'ToUnicode'));
    if (toUnicodeStream) {
      const { text } = streamBytesText(ctx, toUnicodeStream);
      toUnicodeInvalid = /<[0-9A-Fa-f]+>\s*<(0000|FEFF|FFFE)>/.test(text) || /<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*<(0000|FEFF|FFFE)>/.test(text);
    }
    const key = `${base}|${subtype}|${encoding}`;
    if (!fonts.has(key)) {
      fonts.set(key, {
        base,
        subtype,
        encoding,
        embedded,
        exemptFromEmbedding: subtype === 'Type3',
        toUnicode: !!lookup(ctx, dict, 'ToUnicode'),
        exemptFromToUnicode: PREDEFINED_UNICODE_ENCODINGS.has(encoding),
        toUnicodeInvalid,
      });
    }
  }
  function walkResources(resources, depth) {
    if (!resources || depth > 3) return;
    const fontDict = asDict(ctx, lookup(ctx, resources, 'Font'));
    if (fontDict) for (const [, value] of fontDict.entries()) consider(value);
    const xObjects = asDict(ctx, lookup(ctx, resources, 'XObject'));
    if (!xObjects) return;
    for (const [, value] of xObjects.entries()) {
      const stream = streamOf(ctx, value);
      if (stream) walkResources(lookup(ctx, stream.dict, 'Resources'), depth + 1);
    }
  }
  for (const page of doc.getPages()) walkResources(page.node.Resources ? page.node.Resources() : lookup(ctx, page.node, 'Resources'), 0);
  return [...fonts.values()];
}

function parseFields(ctx, catalog, parentTree, pageByRef, pageByNode, elementById) {
  const acro = asDict(ctx, lookup(ctx, catalog, 'AcroForm'));
  const fields = [];
  if (!acro) return fields;

  function fieldPage(dict) {
    const ownPage = pageNumberFor(ctx, lookup(ctx, dict, 'P'), pageByRef, pageByNode, null);
    if (ownPage != null) return ownPage;
    for (const kid of rawArray(ctx, lookup(ctx, dict, 'K'))) {
      const kidDict = dictOfValue(ctx, kid);
      if (!kidDict) continue;
      const page = pageNumberFor(ctx, lookup(ctx, kidDict, 'P'), pageByRef, pageByNode, null);
      if (page != null) return page;
    }
    return null;
  }

  function walk(nodes, parentName, inherited, depth = 0) {
    if (depth > 20) return;
    for (const node of flattenNodes(ctx, nodes)) {
      const dict = dictOfValue(ctx, node);
      if (!dict) continue;
      const partial = textOf(lookup(ctx, dict, 'T'));
      const fqName = partial ? (parentName ? `${parentName}.${partial}` : partial) : parentName;
      const ftRaw = lookup(ctx, dict, 'FT');
      const type = ftRaw ? nameOf(ftRaw) : inherited.type;
      const tooltipRaw = lookup(ctx, dict, 'TU');
      const tooltip = tooltipRaw != null ? textOf(tooltipRaw) : inherited.tooltip;
      const flags = numberOf(lookup(ctx, dict, 'Ff')) ?? inherited.flags;
      const subtype = nameOf(lookup(ctx, dict, 'Subtype'));
      const kids = flattenNodes(ctx, lookup(ctx, dict, 'Kids'));
      const childDicts = kids.map((kid) => dictOfValue(ctx, kid)).filter(Boolean);
      const childFields = childDicts.filter((kid) => lookup(ctx, kid, 'T') != null || lookup(ctx, kid, 'FT') != null);
      const widgetKids = childDicts.filter((kid) => nameOf(lookup(ctx, kid, 'Subtype')) === 'Widget');
      const isWidget = subtype === 'Widget';
      const terminal = type != null && childFields.length === 0;

      if (terminal) {
        const widgets = [];
        if (isWidget) widgets.push({ dict, page: fieldPage(dict) });
        for (const kid of widgetKids) widgets.push({ dict: kid, page: fieldPage(kid) });
        const structParents = [];
        for (const widget of widgets) {
          const key = numberOf(lookup(ctx, widget.dict, 'StructParent'));
          if (key != null) structParents.push(String(key));
        }
        if (!widgets.length) {
          const ownKey = numberOf(lookup(ctx, dict, 'StructParent'));
          if (ownKey != null) structParents.push(String(ownKey));
        }
        const altNames = [];
        for (const key of structParents) {
          const entry = parentTree.byStructParent.get(key);
          if (!entry) continue;
          if (entry.alt) altNames.push(entry.alt);
          if (entry.elementId != null) {
            let element = elementById.get(entry.elementId);
            for (let hop = 0; element && hop < 4; hop += 1) {
              if (element.alt) { altNames.push(element.alt); break; }
              element = element.parentId != null ? elementById.get(element.parentId) : null;
            }
          }
        }
        fields.push({
          name: partial,
          fqName: fqName || partial || '',
          tooltip: tooltip || '',
          altNames,
          type: type || '',
          flags: flags ?? null,
          page: fieldPage(dict),
          terminal: true,
          widgetCount: Math.max(widgets.length, 1),
          structParents,
        });
      }

      if (childFields.length) walk(childFields, fqName || parentName, { type, tooltip, flags }, depth + 1);
    }
  }
  walk(lookup(ctx, acro, 'Fields'), '', { type: null, tooltip: '', flags: null });
  return fields;
}

function countImageResources(ctx, resources, depth = 0) {
  if (!resources || depth > 3) return 0;
  let count = 0;
  const xObjects = asDict(ctx, lookup(ctx, resources, 'XObject'));
  if (xObjects) {
    for (const [, value] of xObjects.entries()) {
      const stream = streamOf(ctx, value);
      if (!stream) continue;
      const subtype = nameOf(lookup(ctx, stream.dict, 'Subtype'));
      if (subtype === 'Image') count += 1;
      else if (subtype === 'Form') count += countImageResources(ctx, lookup(ctx, stream.dict, 'Resources'), depth + 1);
    }
  }
  return count;
}

function countReferenceXObjects(ctx, resources, depth = 0) {
  if (!resources || depth > 3) return 0;
  let count = 0;
  const xObjects = asDict(ctx, lookup(ctx, resources, 'XObject'));
  if (xObjects) {
    for (const [, value] of xObjects.entries()) {
      const stream = streamOf(ctx, value);
      if (!stream) continue;
      if (lookup(ctx, stream.dict, 'Ref') != null) count += 1;
      else if (nameOf(lookup(ctx, stream.dict, 'Subtype')) === 'Form') count += countReferenceXObjects(ctx, lookup(ctx, stream.dict, 'Resources'), depth + 1);
    }
  }
  return count;
}


/** Decode a PDF name token (handles #XX escapes). */
function decodePdfName(name) {
  return name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Collect XObject resources recursively: name -> { stream, kind } for the current level. */
function xobjectResources(ctx, resources) {
  const map = new Map();
  const dict = asDict(ctx, lookup(ctx, resources, 'XObject'));
  if (!dict) return map;
  for (const [key, value] of dict.entries()) {
    const name = decodePdfName(key.asString ? key.asString().replace(/^\//, '') : String(key));
    const stream = streamOf(ctx, value);
    if (!stream) continue;
    const subtype = nameOf(lookup(ctx, stream.dict, 'Subtype'));
    map.set(name, { stream, kind: subtype === 'Image' ? 'image' : subtype === 'Form' ? 'form' : 'other' });
  }
  return map;
}

/**
 * Walk a content stream (and any Form XObjects it paints) to find image
 * XObjects painted outside Figure/Formula/Form or Artifact marked content.
 * This is what PDF/UA-1 §7.3 needs for image coverage and the text layer cannot
 * see it. Inline images are ignored (documented limitation).
 */
function scanUntaggedImages(ctx, contentText, xobjects, depth = 0, inheritedStack = []) {
  if (!contentText || depth > 3) return 0;
  const stack = [...inheritedStack];
  let untagged = 0;
  const token = /\/([A-Za-z0-9#_.+-]+)\s*(?:<<[\s\S]*?>>)?\s*(BDC|BMC)|EMC|\/([A-Za-z0-9#_.+-]+)\s+Do/g;
  let match;
  while ((match = token.exec(contentText)) !== null) {
    if (match[2]) {
      stack.push(decodePdfName(match[1]));
      continue;
    }
    if (match[0] === 'EMC') {
      if (stack.length) stack.pop();
      continue;
    }
    const painted = decodePdfName(match[3] || '');
    const target = xobjects.get(painted);
    if (!target) continue;
    if (target.kind === 'form') {
      untagged += scanUntaggedImages(ctx, streamBytesText(ctx, target.stream).text, xobjectResources(ctx, lookup(ctx, target.stream.dict, 'Resources')), depth + 1, stack);
      continue;
    }
    if (target.kind !== 'image') continue;
    const taggedOrArtifact = stack.some((tag) => /^(Artifact|Figure|Formula|Form)$/i.test(tag));
    if (!taggedOrArtifact) untagged += 1;
  }
  return untagged;
}

function pageContentText(ctx, page) {
  const contents = resolveValue(ctx, lookup(ctx, page.node, 'Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  let text = '';
  for (const entry of streams) {
    const stream = streamOf(ctx, entry);
    if (stream) text += streamBytesText(ctx, stream).text;
  }
  return text;
}

async function parsePageDetails(doc, pdfDoc, options = {}) {
  const ctx = doc.context;
  const pages = [];
  const mcidOrder = new Map();
  const mcidText = new Map();
  const annotations = [];
  const contentByPage = new Map();
  let outline = null;
  let outlineCount = 0;
  let outlineEmpty = 0;
  let artifactInTagged = 0;
  let taggedInArtifact = 0;
  try { outline = await pdfDoc.getOutline(); } catch { outline = null; }
  const walkOutline = (items) => {
    for (const item of items || []) {
      outlineCount += 1;
      if (!String(item.title || '').trim()) outlineEmpty += 1;
      if (item.items) walkOutline(item.items);
    }
  };
  walkOutline(outline);

  const pdfPages = doc.getPages();
  for (let index = 0; index < pdfDoc.numPages; index += 1) {
    if (options.signal?.aborted) { const abort = new Error('Aborted'); abort.name = 'AbortError'; throw abort; }
    const page = await pdfDoc.getPage(index + 1);
    let items = [];
    try {
      const content = await page.getTextContent({ includeMarkedContent: true });
      items = content.items || [];
    } catch { items = []; }

    let chars = 0;
    let untaggedChars = 0;
    const order = [];
    const textByMcid = new Map();
    const markedContent = [];
    const stack = [];
    let pageArtifactInTagged = 0;
    let pageTaggedInArtifact = 0;

    for (const item of items) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
        const tag = String(item.tag || '');
        const isArtifactTag = /^Artifact$/i.test(tag);
        const parentIsArtifact = stack.some((entry) => entry.artifact);
        const ancestorTagged = stack.some((entry) => !entry.artifact);
        if (isArtifactTag && ancestorTagged && !parentIsArtifact) pageArtifactInTagged += 1;
        if (!isArtifactTag && parentIsArtifact) pageTaggedInArtifact += 1;
        const rawId = item.id == null ? null : String(item.id);
        let mcid = null;
        let prefix = '';
        if (rawId != null) {
          const match = /^(p\d+R)_mc(\d+)$/.exec(rawId);
          if (match) { prefix = match[1]; mcid = match[2]; }
          else {
            const simple = /_mc(\d+)$/.exec(rawId);
            if (simple) mcid = simple[1];
          }
        }
        const entry = { tag, artifact: isArtifactTag || parentIsArtifact, mcid, prefix, hasContent: false };
        stack.push(entry);
        if (mcid != null) {
          markedContent.push(entry);
          if (!order.includes(mcid)) order.push(mcid);
        }
        continue;
      }
      if (item.type === 'endMarkedContent') {
        stack.pop();
        continue;
      }
      if (typeof item.str === 'string') {
        const text = item.str;
        const length = text.replace(/\s/g, '').length;
        chars += length;
        const insideArtifact = stack.some((entry) => entry.artifact);
        for (const frame of stack) frame.hasContent = true;
        const current = stack.length ? stack[stack.length - 1].mcid : null;
        if (current == null && !insideArtifact) untaggedChars += length;
        if (current != null) {
          const previous = textByMcid.get(current) || '';
          textByMcid.set(current, `${previous}${text}`);
        }
      }
    }

    if (order.length) mcidOrder.set(index + 1, order);
    if (textByMcid.size) mcidText.set(index + 1, textByMcid);
    artifactInTagged += pageArtifactInTagged;
    taggedInArtifact += pageTaggedInArtifact;

    const resources = pdfPages[index].node.Resources ? pdfPages[index].node.Resources() : lookup(ctx, pdfPages[index].node, 'Resources');
    let images = countImageResources(ctx, resources);
    const isScannedPage = images > 0 && chars < 20;
    let pageUntaggedImages = 0;
    if (!isScannedPage) {
      try {
        pageUntaggedImages = scanUntaggedImages(ctx, pageContentText(ctx, pdfPages[index]), xobjectResources(ctx, resources));
      } catch { pageUntaggedImages = 0; }
    }
    const node = pdfPages[index].node;
    const annotsRaw = lookup(ctx, node, 'Annots');
    const annots = arrayOf(ctx, annotsRaw).map((value) => asDict(ctx, value)).filter(Boolean);
    if (process.env.DEBUG_ANNOTS) {
      const rawEntries = rawArray(ctx, annotsRaw);
      console.error('DEBUG annots', index, annotsRaw && annotsRaw.constructor && annotsRaw.constructor.name, 'raw', rawEntries.length, 'resolved', rawEntries.map((entry) => (entry instanceof PDFRef ? 'ref' : entry && entry.constructor && entry.constructor.name)).slice(0, 4), 'mapped', annots.length);
      const resolvedList = arrayOf(ctx, annotsRaw);
      console.error('DEBUG arrayOf types', resolvedList.map((v) => v === null ? 'null' : v === undefined ? 'undef' : (v.constructor && v.constructor.name)), 'asDict', resolvedList.map((v) => asDict(ctx, v) ? 'dict' : 'no'));

    }
    for (const annot of annots) {
      annotations.push({
        page: index + 1,
        subtype: nameOf(lookup(ctx, annot, 'Subtype')),
        structParent: numberOf(lookup(ctx, annot, 'StructParent')),
        contents: textOf(lookup(ctx, annot, 'Contents')),
        tooltip: textOf(lookup(ctx, annot, 'TU')),
        rect: lookup(ctx, annot, 'Rect'),
      });
    }
    pages.push({
      number: index + 1,
      chars,
      untaggedChars,
      images,
      hasText: chars > 0,
      annotations: annots.length,
      tabs: nameOf(lookup(ctx, node, 'Tabs')),
      untaggedImages: pageUntaggedImages,
      scanned: isScannedPage,
      blank: images === 0 && chars === 0,
      sparse: chars > 0 && chars < 20 && images === 0,
    });
    contentByPage.set(index + 1, {
      markedContent,
      artifactNesting: { artifactInTagged: pageArtifactInTagged, taggedInArtifact: pageTaggedInArtifact },
    });
    if (typeof page.cleanup === 'function') { try { page.cleanup(); } catch { /* ignore */ } }
  }

  const untaggedImagePages = pages.filter((page) => page.untaggedImages > 0).map((page) => page.number);
  return {
    pages,
    untaggedImages: { count: pages.reduce((sum, page) => sum + page.untaggedImages, 0), pages: untaggedImagePages },
    mcidOrder,
    mcidText,
    annotations,
    contentByPage,
    artifactNesting: { artifactInTagged, taggedInArtifact },
    outline,
    outlineCount,
    outlineEmpty,
  };
}

// ---------------------------------------------------------------------------
// Document-level metadata and permissions
// ---------------------------------------------------------------------------

function xmpTitle(xmp) {
  const match = /<dc:title[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(String(xmp || ''));
  return match ? match[1].trim() : '';
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readXmp(ctx, doc) {
  const stream = streamOf(ctx, lookup(ctx, doc.catalog, 'Metadata'));
  if (!stream) return { text: '', present: false, compressed: false, valid: false, title: '' };
  const { text, compressed } = streamBytesText(ctx, stream);
  const title = decodeXmlEntities(xmpTitle(text)).replace(/\s+/g, ' ').trim();
  const type = nameOf(lookup(ctx, stream.dict, 'Type'));
  const subtype = nameOf(lookup(ctx, stream.dict, 'Subtype'));
  const valid = type === 'Metadata' && subtype === 'XML';
  return { text, present: true, compressed, valid, title };
}

function readEncryption(doc) {
  let encrypt = null;
  try {
    const trailer = doc.context.trailerInfo || {};
    const raw = trailer.Encrypt;
    if (raw) encrypt = dictOfValue(doc.context, raw);
  } catch { encrypt = null; }
  if (!encrypt && doc.isEncrypted) {
    const fallback = lookup(doc.context, doc.catalog, 'Encrypt');
    if (fallback) encrypt = dictOfValue(doc.context, fallback);
  }
  if (!encrypt) return { encrypted: !!doc.isEncrypted, allowsAccessibility: null, p: null, hasPermissions: false };
  const permissions = numberOf(lookup(doc.context, encrypt, 'P'));
  return {
    encrypted: true,
    p: permissions,
    allowsAccessibility: permissions == null ? null : (permissions & (1 << 9)) !== 0,
    hasPermissions: permissions != null,
  };
}

function readXfa(ctx, doc) {
  const acro = asDict(ctx, lookup(ctx, doc.catalog, 'AcroForm'));
  const raw = acro ? lookup(ctx, acro, 'XFA') : undefined;
  if (raw == null) return { present: false, dynamic: false };
  let text = '';
  const resolved = resolveValue(ctx, raw);
  if (resolved instanceof PDFArray) {
    for (const entry of resolved.asArray()) {
      const stream = streamOf(ctx, entry);
      if (stream) text += streamBytesText(ctx, stream).text;
    }
  } else {
    const stream = streamOf(ctx, raw);
    if (stream) text = streamBytesText(ctx, stream).text;
  }
  const dynamic = /dynamicRender\s*=\s*["']required["']/i.test(text) || /renderPolicy\s*=\s*["']dynamic["']/i.test(text);
  return { present: true, dynamic };
}

function readOptionalContent(ctx, doc) {
  const properties = asDict(ctx, lookup(ctx, doc.catalog, 'OCProperties'));
  if (!properties) return { present: false, named: false, hasAs: false };
  const defaults = asDict(ctx, lookup(ctx, properties, 'D'));
  const name = defaults ? textOf(lookup(ctx, defaults, 'Name')) : '';
  const hasAs = !!(defaults && lookup(ctx, defaults, 'AS') != null);
  return { present: true, named: !!name.trim(), hasAs };
}

function readEmbeddedFiles(ctx, doc) {
  const names = asDict(ctx, lookup(ctx, doc.catalog, 'Names'));
  if (!names) return { present: false, missing: [] };
  const tree = lookup(ctx, names, 'EmbeddedFiles');
  const files = [];
  const visit = (node) => {
    const dict = asDict(ctx, node);
    if (!dict) return;
    const entries = rawArray(ctx, lookup(ctx, dict, 'Names'));
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const spec = dictOfValue(ctx, entries[index + 1]);
      if (spec) files.push(spec);
    }
    for (const kid of rawArray(ctx, lookup(ctx, dict, 'Kids'))) visit(kid);
  };
  visit(tree);
  const missing = [];
  for (const spec of files) {
    if (!textOf(lookup(ctx, spec, 'F')) || !textOf(lookup(ctx, spec, 'UF'))) {
      missing.push(textOf(lookup(ctx, spec, 'F')) || '(unnamed)');
    }
  }
  return { present: files.length > 0, count: files.length, missing };
}

function pdfHeaderVersion(data) {
  const head = Buffer.from(data.slice(0, Math.min(1024, data.length))).toString('latin1');
  const match = /%PDF-(\d+\.\d+)/.exec(head);
  return match ? match[1] : '';
}

function pageByRefMaps(doc) {
  const pages = doc.getPages();
  return {
    pageByRef: new Map(pages.map((page, index) => [refKey(page.ref), index + 1])),
    pageByNode: new Map(pages.map((page, index) => [page.node, index + 1])),
  };
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export async function loadPdf(filePath, options = {}) {
  const absolute = path.resolve(process.cwd(), filePath);
  const fs = await import('node:fs/promises');
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    const error = new Error(`File not found: ${filePath}`);
    error.code = 'PDF_NOT_FOUND';
    throw error;
  }
  if (!stat.isFile()) {
    const error = new Error(`Not a file: ${filePath}`);
    error.code = 'PDF_NOT_FILE';
    throw error;
  }
  if (!stat.size) {
    const error = new Error(`The PDF is empty: ${filePath}`);
    error.code = 'PDF_EMPTY';
    throw error;
  }
  const data = await fs.readFile(absolute);
  const hash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(data).digest('hex'));
  let doc;
  // pdf-lib logs parser warnings for encrypted and malformed objects. The audit
  // reports those conditions itself, so keep the CLI/MCP output to one message.
  const warn = console.warn;
  console.warn = () => {};
  try {
    doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    const error = new Error(`Could not parse the PDF: ${err.message}`);
    error.code = 'PDF_PARSE_FAILED';
    throw error;
  } finally {
    console.warn = warn;
  }
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  let pdfjs;
  try {
    pdfjs = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => {});
    const password = err && (err.name === 'PasswordException' || err.code === 1);
    const error = new Error(password
      ? 'This PDF is encrypted. Remove the open password or provide an unlocked copy before auditing.'
      : `Could not read the PDF text layer: ${err && err.message || err}`);
    error.code = password ? 'PDF_ENCRYPTED' : 'PDF_TEXT_LAYER_FAILED';
    throw error;
  }
  try {
    const structure = parseStructure(doc);
    const parentTree = parseParentTree(doc, structure);
    structure.parentTreePresent = parentTree.present;
    parentTree.byStream = parseStreamParentTrees(doc, parentTree);
    const fonts = parseFonts(doc.context, doc);
    const { pageByRef, pageByNode } = pageByRefMaps(doc);
    const pageDetails = await parsePageDetails(doc, pdfjs, options);
    const xmp = readXmp(doc.context, doc);
    const encryption = readEncryption(doc);
    const xfa = readXfa(doc.context, doc);
    const optionalContent = readOptionalContent(doc.context, doc);
    const embeddedFiles = readEmbeddedFiles(doc.context, doc);
    const referenceXObjects = doc.getPages().reduce((sum, page) => sum + countReferenceXObjects(doc.context, page.node.Resources ? page.node.Resources() : lookup(doc.context, page.node, 'Resources')), 0);

    // parseFields needs access to element records for enclosing-alt lookup.
    const fields = parseFields(doc.context, doc.catalog, parentTree, pageByRef, pageByNode, structure.elementById);

    const metadataTitle = (doc.getTitle() || '').trim();
    const claimPdfua = /pdfuaid\s*:\s*part|pdfuaid:part|<pdfuaid:part/i.test(xmp.text);
    return {
      path: absolute,
      fileName: path.basename(absolute),
      bytes: data.length,
      sha256: hash,
      encrypted: encryption.encrypted,
      headerVersion: pdfHeaderVersion(data),
      pageCount: doc.getPageCount(),
      metadata: {
        title: metadataTitle,
        author: doc.getAuthor() || '',
        subject: doc.getSubject() || '',
        keywords: doc.getKeywords() || '',
        creator: doc.getCreator() || '',
        producer: doc.getProducer() || '',
      },
      language: textOf(lookup(doc.context, doc.catalog, 'Lang')),
      displayDocTitle: boolOf(lookup(doc.context, asDict(doc.context, lookup(doc.context, doc.catalog, 'ViewerPreferences')), 'DisplayDocTitle')),
      xmp: xmp.text,
      xmpPresent: xmp.present,
      xmpValid: xmp.valid,
      xmpCompressed: xmp.compressed,
      xmpTitle: xmp.title,
      pdfuaClaim: claimPdfua,
      encryption,
      xfa,
      optionalContent,
      embeddedFiles,
      referenceXObjects,
      pagePrefixes: doc.getPages().map((page) => page.ref.objectNumber),
      structure,
      parentTree,
      fonts,
      fields,
      ...pageDetails,
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export { MAX_INSTANCES_PER_RULE, HEADING_ROLES, FIGURE_ROLES, TABLE_CHILD_ROLES, TABLE_ROW_CELL_ROLES };

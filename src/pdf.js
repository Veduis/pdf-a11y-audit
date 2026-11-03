/**
 * PDF loading and structure extraction.
 *
 * pdf-lib gives us the object model (structure tree, fonts, forms, annotations).
 * PDF.js gives us text extraction and marked-content order. Both are local and
 * deterministic; no document ever leaves the machine.
 */
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString, PDFNumber } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const STANDARD_ROLES = new Set([
  'Document', 'Part', 'Sect', 'Div', 'Aside', 'Art', 'BlockQuote', 'Caption',
  'TOC', 'TOCI', 'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD',
  'THead', 'TBody', 'TFoot', 'Span', 'Quote', 'Note', 'Reference', 'BibEntry',
  'Code', 'Link', 'Annot', 'Figure', 'Formula', 'Form', 'Ruby', 'Warichu',
  'WT', 'WP', 'Artifact',
]);

function normalizeMcid(value) {
  const text = String(value == null ? '' : value);
  const match = /_mc(\d+)$/.exec(text);
  return match ? match[1] : text;
}

const IMAGE_OPS = new Set([
  OPS.paintImageXObject,
  OPS.paintJpegXObject,
  OPS.paintImageMaskXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageXObjectRepeat,
].filter((value) => value !== undefined));

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

function arrayOf(ctx, value) {
  if (!value) return [];
  if (value instanceof PDFRef) value = ctx.lookup(value);
  if (value instanceof PDFArray) return value.asArray().map((item) => (item instanceof PDFRef ? ctx.lookup(item) : item));
  return Array.isArray(value) ? value : [value];
}

function refKey(ref) {
  return ref instanceof PDFRef ? `${ref.objectNumber}g${ref.generationNumber}` : '';
}

function pageNumberFor(ctx, value, pageByRef, pageByNode, fallback = null) {
  if (value instanceof PDFRef) return pageByRef.get(refKey(value)) || fallback;
  const dict = asDict(ctx, value);
  if (dict && pageByNode.has(dict)) return pageByNode.get(dict);
  return fallback;
}

function parseAttributes(ctx, value) {
  const out = {};
  for (const item of arrayOf(ctx, value)) {
    const dict = asDict(ctx, item);
    if (!dict) continue;
    const scope = nameOf(lookup(ctx, dict, 'Scope'));
    const headers = arrayOf(ctx, lookup(ctx, dict, 'Headers')).map((entry) => textOf(entry)).filter(Boolean);
    const owner = nameOf(lookup(ctx, dict, 'O'));
    if (scope) out.scope = scope;
    if (headers.length) out.headers = headers;
    if (owner) out.owner = owner;
  }
  return out;
}

function parseStructure(doc) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const pageByRef = new Map(pages.map((page, index) => [refKey(page.ref), index + 1]));
  const pageByNode = new Map(pages.map((page, index) => [page.node, index + 1]));
  const root = asDict(ctx, lookup(ctx, doc.catalog, 'StructTreeRoot'));
  const result = {
    present: !!root,
    marked: boolOf(lookup(ctx, doc.catalog, 'MarkInfo') && lookup(ctx, asDict(ctx, lookup(ctx, doc.catalog, 'MarkInfo')), 'Marked')),
    parentTree: (() => {
      if (!root) return false;
      const tree = asDict(ctx, lookup(ctx, root, 'ParentTree'));
      return !!(tree && (lookup(ctx, tree, 'Nums') || lookup(ctx, tree, 'Kids')));
    })(),
    suspects: boolOf(root && lookup(ctx, root, 'Suspects')),
    roleMap: new Map(),
    customRoles: new Set(),
    elements: [],
    headings: [],
    tables: [],
    figures: [],
    lists: [],
    links: [],
    mcidByPage: new Map(),
    structureOrder: new Map(),
    counts: {},
  };
  if (!root) return result;

  const roleMap = asDict(ctx, lookup(ctx, root, 'RoleMap'));
  if (roleMap) {
    for (const [key, value] of roleMap.entries()) {
      const from = nameOf(key);
      const to = nameOf(ctx.lookup(value));
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
    if (!result.structureOrder.has(page)) result.structureOrder.set(page, []);
    result.structureOrder.get(page).push(String(mcid));
  }

  function walk(value, context) {
    if (value === null || value === undefined) return;
    if (value instanceof PDFNumber || typeof value === 'number') {
      const number = value instanceof PDFNumber ? value.asNumber() : Number(value);
      collectMcid(context.page, number);
      if (context.mcids) context.mcids.push(String(number));
      return;
    }
    const list = Array.isArray(value) ? value : null;
    if (list) { for (const item of list) walk(item, context); return; }
    if (value instanceof PDFArray) { for (const item of value.asArray()) walk(item, context); return; }
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
    if (rawRole && !STANDARD_ROLES.has(rawRole) && !result.roleMap.has(rawRole)) result.customRoles.add(rawRole);

    const element = {
      id: id++,
      role,
      rawRole,
      page,
      depth: context.depth,
      parentId: context.parentId,
      hasAlt: !!lookup(ctx, dict, 'Alt'),
      hasActualText: !!lookup(ctx, dict, 'ActualText'),
      alt: textOf(lookup(ctx, dict, 'Alt')) || textOf(lookup(ctx, dict, 'ActualText')),
      actualText: textOf(lookup(ctx, dict, 'ActualText')),
      title: textOf(lookup(ctx, dict, 'T')),
      attributes: parseAttributes(ctx, lookup(ctx, dict, 'A')),
      mcids: [],
      text: '',
    };

    if (role) {
      result.elements.push(element);
      if (/^H[1-6]$/.test(role)) result.headings.push(element);
      if (role === 'Table') result.tables.push(element);
      if (role === 'Figure' || role === 'Formula' || role === 'Form') result.figures.push(element);
      if (role === 'L') result.lists.push(element);
      if (role === 'Link') result.links.push(element);
      result.counts[role] = (result.counts[role] || 0) + 1;
    }

    const kids = lookup(ctx, dict, 'K');
    if (kids) {
      const childMcids = [];
      walk(kids, { page, depth: context.depth + 1, parentId: role ? element.id : context.parentId, mcids: childMcids });
      element.mcids = childMcids;
    }
  }

  walk(lookup(ctx, root, 'K'), { page: 1, depth: 1, parentId: null });
  result.present = true;
  result.marked = boolOf(lookup(ctx, asDict(ctx, lookup(ctx, doc.catalog, 'MarkInfo')), 'Marked'));
  return result;
}

function parseFonts(doc) {
  const ctx = doc.context;
  const fonts = new Map();
  function consider(value) {
    const dict = asDict(ctx, value);
    if (!dict) return;
    const base = textOf(lookup(ctx, dict, 'BaseFont'));
    const subtype = nameOf(lookup(ctx, dict, 'Subtype'));
    const descriptor = asDict(ctx, lookup(ctx, dict, 'FontDescriptor'));
    let embedded = !!descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => !!lookup(ctx, descriptor, key));
    if (subtype === 'Type0') {
      for (const descendant of arrayOf(ctx, lookup(ctx, dict, 'DescendantFonts'))) {
        const d = asDict(ctx, descendant);
        if (!d) continue;
        const dd = asDict(ctx, lookup(ctx, d, 'FontDescriptor'));
        if (dd && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => !!lookup(ctx, dd, key))) embedded = true;
      }
    }
    const key = `${base}|${subtype}|${embedded}`;
    if (!fonts.has(key)) fonts.set(key, { base, subtype, embedded, toUnicode: !!lookup(ctx, dict, 'ToUnicode') });
  }
  for (const page of doc.getPages()) {
    const resources = asDict(ctx, lookup(ctx, page.node, 'Resources'));
    const fontDict = asDict(ctx, lookup(ctx, resources, 'Font'));
    if (!fontDict) continue;
    for (const value of fontDict.values()) consider(value);
  }
  return [...fonts.values()];
}

function parseFields(doc) {
  const ctx = doc.context;
  const acro = asDict(ctx, lookup(ctx, doc.catalog, 'AcroForm'));
  const fields = [];
  function walk(value) {
    for (const item of arrayOf(ctx, value)) {
      const dict = asDict(ctx, item);
      if (!dict) continue;
      const kids = lookup(ctx, dict, 'Kids');
      const subtype = nameOf(lookup(ctx, dict, 'Subtype'));
      const fieldName = lookup(ctx, dict, 'T');
      const fieldType = lookup(ctx, dict, 'FT');
      // A simple AcroForm field is both field and widget; do not skip it just
      // because its subtype is Widget.
      if (subtype !== 'Widget' || fieldName || fieldType) {
        fields.push({
          name: textOf(fieldName),
          tooltip: textOf(lookup(ctx, dict, 'TU')),
          type: nameOf(fieldType),
          flags: numberOf(lookup(ctx, dict, 'Ff')),
          structParent: lookup(ctx, dict, 'StructParent'),
          subtype,
        });
      }
      if (kids) walk(kids);
    }
  }
  if (acro) walk(lookup(ctx, acro, 'Fields'));
  return fields;
}

function parsePageDetails(doc, pdfDoc) {
  return (async () => {
    const ctx = doc.context;
    const pages = [];
    const mcidOrder = new Map();
    const mcidText = new Map();
    const annotations = [];
    let outline = null;
    let outlineCount = 0;
    let outlineEmpty = 0;
    try {
      outline = await pdfDoc.getOutline();
    } catch { outline = null; }
    const walkOutline = (items) => {
      for (const item of items || []) {
        outlineCount += 1;
        if (!String(item.title || '').trim()) outlineEmpty += 1;
        if (item.items) walkOutline(item.items);
      }
    };
    walkOutline(outline);

    for (let index = 0; index < pdfDoc.numPages; index += 1) {
      const page = await pdfDoc.getPage(index + 1);
      let items = [];
      try {
        const content = await page.getTextContent({ includeMarkedContent: true });
        items = content.items || [];
      } catch { items = []; }
      let chars = 0;
      let untaggedChars = 0;
      let images = 0;
      const order = [];
      const textByMcid = new Map();
      const stack = [];
      let artifactDepth = 0;
      for (const item of items) {
        if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
          const tag = String(item.tag || '');
          if (/^Artifact$/i.test(tag)) artifactDepth += 1;
          const mcid = item.id == null ? null : normalizeMcid(item.id);
          stack.push(mcid);
          if (mcid != null && !order.includes(mcid)) order.push(mcid);
          continue;
        }
        if (item.type === 'endMarkedContent') {
          if (artifactDepth > 0) artifactDepth -= 1;
          stack.pop();
          continue;
        }
        if (typeof item.str === 'string') {
          const text = item.str;
          const length = text.replace(/\s/g, '').length;
          chars += length;
          const current = stack.length ? stack[stack.length - 1] : null;
          if (current == null && artifactDepth === 0) untaggedChars += length;
          if (current != null) {
            const previous = textByMcid.get(current) || '';
            textByMcid.set(current, `${previous}${text}`);
          }
        }
      }
      if (order.length) mcidOrder.set(index + 1, order);
      if (textByMcid.size) mcidText.set(index + 1, textByMcid);
      try {
        const ops = await page.getOperatorList();
        for (const fn of ops.fnArray || []) if (IMAGE_OPS.has(fn)) images += 1;
      } catch { images = 0; }

      const node = doc.getPages()[index].node;
      const annots = arrayOf(ctx, lookup(ctx, node, 'Annots')).map((value) => asDict(ctx, value)).filter(Boolean);
      for (const annot of annots) {
        const subtype = nameOf(lookup(ctx, annot, 'Subtype'));
        annotations.push({
          page: index + 1,
          subtype,
          structParent: lookup(ctx, annot, 'StructParent'),
          contents: textOf(lookup(ctx, annot, 'Contents')) || textOf(lookup(ctx, annot, 'TU')),
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
        scanned: images > 0 && chars < 20,
        blank: images === 0 && chars === 0,
        sparse: chars > 0 && chars < 20 && images === 0,
      });
    }
    return { pages, mcidOrder, mcidText, annotations, outline, outlineCount, outlineEmpty };
  })();
}

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
    const fonts = parseFonts(doc);
    const fields = parseFields(doc);
    const pageDetails = await parsePageDetails(doc, pdfjs);
    return {
      path: absolute,
      fileName: path.basename(absolute),
      bytes: data.length,
      sha256: hash,
      encrypted: !!doc.isEncrypted,
      pageCount: doc.getPageCount(),
      metadata: {
        title: doc.getTitle() || '',
        author: doc.getAuthor() || '',
        subject: doc.getSubject() || '',
        keywords: doc.getKeywords() || '',
        creator: doc.getCreator() || '',
        producer: doc.getProducer() || '',
      },
      language: textOf(lookup(doc.context, doc.catalog, 'Lang')),
      displayDocTitle: boolOf(lookup(doc.context, asDict(doc.context, lookup(doc.context, doc.catalog, 'ViewerPreferences')), 'DisplayDocTitle')),
      xmp: (() => {
        const stream = lookup(doc.context, doc.catalog, 'Metadata');
        try { return stream && stream.getContentsString ? stream.getContentsString() : ''; } catch { return ''; }
      })(),
      structure,
      fonts,
      fields,
      ...pageDetails,
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

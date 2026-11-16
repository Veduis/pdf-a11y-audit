/**
 * Deterministic PDF fixtures for the auditor tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFNumber } from 'pdf-lib';

const XMP_TITLE = (title) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
   <pdfuaid:part>1</pdfuaid:part>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

function setMetadata(doc, title, { compress = false } = {}) {
  const ctx = doc.context;
  const dict = { Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') };
  const stream = compress ? ctx.flateStream(XMP_TITLE(title), dict) : ctx.stream(XMP_TITLE(title), dict);
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(stream));
}

function structElem(ctx, { role, parent, page, k, alt, actualText, title, id, attrs }) {
  const dict = {
    Type: PDFName.of('StructElem'),
    S: PDFName.of(role),
    ...(parent ? { P: parent } : {}),
    ...(page ? { Pg: page.ref } : {}),
    ...(k === undefined ? {} : { K: k }),
    ...(alt === undefined ? {} : { Alt: PDFString.of(alt) }),
    ...(actualText === undefined ? {} : { ActualText: PDFString.of(actualText) }),
    ...(title === undefined ? {} : { T: PDFString.of(title) }),
    ...(id === undefined ? {} : { ID: PDFString.of(id) }),
    ...(attrs ? { A: ctx.obj(attrs) } : {}),
  };
  return ctx.register(ctx.obj(dict));
}

function fontResources(ctx) {
  return ctx.obj({
    Font: {
      F1: {
        Type: PDFName.of('Font'),
        Subtype: PDFName.of('Type1'),
        BaseFont: PDFName.of('Helvetica'),
      },
    },
  });
}

function structure(doc, page, { good }) {
  const ctx = doc.context;
  const root = ctx.obj({ Type: PDFName.of('StructTreeRoot'), RoleMap: ctx.obj({}) });
  const rootRef = ctx.register(root);
  const refs = [];
  const make = ({ role, parent = rootRef, k, alt, attrs }) => {
    const dict = ctx.obj({
      Type: PDFName.of('StructElem'),
      S: PDFName.of(role),
      P: parent,
      Pg: page.ref,
      ...(k === undefined ? {} : { K: k }),
      ...(alt === undefined ? {} : { Alt: PDFString.of(alt) }),
      ...(attrs ? { A: ctx.obj(attrs) } : {}),
    });
    const ref = ctx.register(dict);
    refs.push(ref);
    return ref;
  };

  const h1 = make({ role: 'H1', k: 0 });
  const p = make({ role: 'P', k: 1 });
  const figure = make({ role: 'Figure', ...(good ? { alt: 'A chart of the adopted budget by department.' } : {}) });

  const th = make({ role: 'TH', k: 2, ...(good ? { attrs: { O: PDFName.of('Table'), Scope: PDFName.of('Column') } } : {}) });
  const td = make({ role: 'TD', k: 3 });
  const td2 = make({ role: 'TD', k: 5 });
  const tr = make({ role: 'TR', k: good ? [th, td, td2] : [th, td] });
  const table = make({ role: 'Table', k: [tr] });

  const lbody = make({ role: 'LBody', k: 4 });
  const li = make({ role: 'LI', k: good ? [lbody] : [] });
  const list = make({ role: 'L', k: [li] });

  let badTable = null;
  let noHeaderTable = null;
  let h3 = null;
  let emptyH2 = null;
  if (!good) {
    const emptyTh = make({ role: 'TH' });
    const emptyTd = make({ role: 'TD', k: 5 });
    const emptyTr = make({ role: 'TR', k: [emptyTh, emptyTd] });
    badTable = make({ role: 'Table', k: [emptyTr] });
    const dataOnly = make({ role: 'TD', k: 5 });
    const dataRow = make({ role: 'TR', k: [dataOnly] });
    noHeaderTable = make({ role: 'Table', k: [dataRow] });
    h3 = make({ role: 'H3', k: 6 });
    emptyH2 = make({ role: 'H2' });
  }

  const link = make({ role: 'Link', k: 7 });
  const all = [h1, p, figure, table, list, link, ...(badTable ? [badTable] : []), ...(noHeaderTable ? [noHeaderTable] : []), ...(h3 ? [h3] : []), ...(emptyH2 ? [emptyH2] : [])];
  root.set(PDFName.of('K'), ctx.obj(all));
  if (good) {
    const parentTree = ctx.obj({ Nums: [0, refs] });
    root.set(PDFName.of('ParentTree'), ctx.register(parentTree));
  }
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  return { rootRef, refs };
}

function contentStream(good) {
  const lines = [
    'q',
    'BT /F1 20 Tf 72 740 Td /H1 <</MCID 0>> BDC (Annual Budget) Tj EMC ET',
    'BT /F1 11 Tf 72 710 Td /P <</MCID 1>> BDC (The county adopted the annual budget.) Tj EMC ET',
    'BT /F1 11 Tf 72 680 Td /TH <</MCID 2>> BDC (Department) Tj EMC ET',
    'BT /F1 11 Tf 72 660 Td /TD <</MCID 3>> BDC (Public Works) Tj EMC ET',
    'BT /F1 11 Tf 72 600 Td /TD <</MCID 5>> BDC (Utilities) Tj EMC ET',
    'BT /F1 11 Tf 72 620 Td /LBody <</MCID 4>> BDC (Road maintenance) Tj EMC ET',
    'BT /F1 11 Tf 72 540 Td /Link <</MCID 7>> BDC (Budget website) Tj EMC ET',
    'BT /F1 9 Tf 72 30 Td /Artifact BMC (Confidential - page footer) Tj EMC ET',
    'Q',
  ];
  if (!good) lines.splice(2, 0, 'BT /F1 14 Tf 72 720 Td /H3 <</MCID 6>> BDC (A skipped heading) Tj EMC ET', 'BT /F1 14 Tf 72 700 Td /H3 <</MCID 8>> BDC (Another heading) Tj EMC ET');
  return lines.join('\n');
}

async function makeTagged(good) {
  const doc = await PDFDocument.create();
  doc.setTitle('Tagged accessibility fixture');
  if (good) setMetadata(doc, 'Tagged accessibility fixture');
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  page.node.set(PDFName.of('Resources'), fontResources(ctx));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(contentStream(good))));
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));
  if (good) page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  if (good) {
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'));
    doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));
  }

  const link = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: ctx.obj([72, 530, 200, 550]),
    ...(good ? { Contents: PDFString.of('Budget website'), StructParent: ctx.obj(7) } : {}),
    A: ctx.obj({ S: PDFName.of('URI'), URI: PDFString.of('https://example.com/budget') }),
  });
  const linkRef = ctx.register(link);
  const field = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Widget'),
    FT: PDFName.of('Tx'),
    T: PDFString.of('Name'),
    ...(good ? { TU: PDFString.of('Full name'), StructParent: ctx.obj(8) } : {}),
    Rect: ctx.obj([72, 490, 300, 510]),
    P: page.ref,
  });
  const fieldRef = ctx.register(field);
  page.node.set(PDFName.of('Annots'), ctx.obj([linkRef, fieldRef]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [fieldRef], DA: PDFString.of('/F1 10 Tf 0 g') }));

  structure(doc, page, { good });
  return doc.save();
}


function basePageDoc(doc, { title, withResources = true, tabs = true } = {}) {
  if (title) doc.setTitle(title);
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  if (withResources) page.node.set(PDFName.of('Resources'), fontResources(ctx));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q Q')));
  page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
  if (tabs) page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'));
  doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));
  const root = ctx.obj({ Type: PDFName.of('StructTreeRoot'), RoleMap: ctx.obj({}) });
  const rootRef = ctx.register(root);
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  return { page, ctx, root, rootRef };
}

async function makeMarkedContent({ orphan = false } = {}) {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Marked content fixture' });
  const lines = [
    'q',
    'BT /F1 12 Tf 72 700 Td',
    '/Artifact <</MCID 0>> BDC',
    '(Confidential footer) Tj',
    'EMC',
    '/P <</MCID 1>> BDC',
    '(Tagged body text) Tj',
    'EMC',
    ...(orphan ? ['/Content <</MCID 2>> BDC', '(Orphan text) Tj', 'EMC'] : []),
    'ET',
    'Q',
  ];
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(lines.join('\n'))));
  const p = structElem(ctx, { role: 'P', parent: rootRef, page, k: 1 });
  const artifact = structElem(ctx, { role: 'Artifact', parent: rootRef, page, k: 0 });
  root.set(PDFName.of('K'), ctx.obj([p]));
  const entries = ctx.obj([artifact, p]);
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, entries] })));
  return doc.save();
}

async function makeFormTree() {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Form tree fixture', withResources: false });
  const form = structElem(ctx, { role: 'Form', parent: rootRef, page });
  root.set(PDFName.of('K'), ctx.obj([form]));
  const widgets = [1, 2].map((index) => {
    const dict = ctx.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Widget'),
      FT: PDFName.of('Tx'),
      T: PDFString.of(`f1_0${index}[0]`),
      Rect: ctx.obj([72, 700 - index * 30, 300, 720 - index * 30]),
      P: page.ref,
      StructParent: PDFNumber.of(index),
    });
    return { ref: ctx.register(dict), dict };
  });
  page.node.set(PDFName.of('Annots'), ctx.obj(widgets.map((widget) => widget.ref)));
  const nestedWidgetArray = ctx.obj(widgets.map((widget) => widget.ref));
  const pageField = ctx.register(ctx.obj({ T: PDFString.of('Page1[0]'), Kids: ctx.obj([nestedWidgetArray]) }));
  const top = ctx.register(ctx.obj({ T: PDFString.of('topmostSubform[0]'), Kids: ctx.obj([ctx.obj([pageField])]) }));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([top]) }));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([]), 1, form, 2, form] })));
  return doc.save();
}

async function makeTableFixture(kind) {
  const doc = await PDFDocument.create();
  const { ctx, root, rootRef } = basePageDoc(doc, { title: `${kind} table fixture`, withResources: false });
  if (kind === 'headers-id') {
    const row1 = ctx.register(ctx.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR') }));
    const row2 = ctx.register(ctx.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR') }));
    const h1 = structElem(ctx, { role: 'TH', parent: row1, actualText: 'Column A', id: 'h1' });
    const h2 = structElem(ctx, { role: 'TH', parent: row1, actualText: 'Column B', id: 'h2' });
    const d1 = structElem(ctx, { role: 'TD', parent: row2, attrs: { O: PDFName.of('Table'), Headers: [PDFString.of('h1')] } });
    const d2 = structElem(ctx, { role: 'TD', parent: row2, attrs: { O: PDFName.of('Table'), Headers: [PDFString.of('h2')] } });
    ctx.lookup(row1).set(PDFName.of('P'), rootRef); ctx.lookup(row1).set(PDFName.of('K'), ctx.obj([h1, h2]));
    ctx.lookup(row2).set(PDFName.of('P'), rootRef); ctx.lookup(row2).set(PDFName.of('K'), ctx.obj([d1, d2]));
    const table = structElem(ctx, { role: 'Table', parent: rootRef, k: [row1, row2] });
    root.set(PDFName.of('K'), ctx.obj([table]));
  } else {
    const row1 = ctx.register(ctx.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR') }));
    const row2 = ctx.register(ctx.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR') }));
    const h1 = structElem(ctx, { role: 'TH', parent: row1, actualText: 'Group A', attrs: { O: PDFName.of('Table'), ColSpan: PDFNumber.of(2) } });
    const h2 = structElem(ctx, { role: 'TH', parent: row1, actualText: 'Group B', attrs: { O: PDFName.of('Table'), ColSpan: PDFNumber.of(2) } });
    const d1 = structElem(ctx, { role: 'TD', parent: row2, attrs: { O: PDFName.of('Table'), ColSpan: PDFNumber.of(4) } });
    ctx.lookup(row1).set(PDFName.of('P'), rootRef); ctx.lookup(row1).set(PDFName.of('K'), ctx.obj([h1, h2]));
    ctx.lookup(row2).set(PDFName.of('P'), rootRef); ctx.lookup(row2).set(PDFName.of('K'), ctx.obj([d1]));
    const table = structElem(ctx, { role: 'Table', parent: rootRef, k: [row1, row2] });
    root.set(PDFName.of('K'), ctx.obj([table]));
  }
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([])] })));
  return doc.save();
}

async function makeStrongH() {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Strong heading fixture' });
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q BT /F1 16 Tf 72 720 Td /H <</MCID 0>> BDC (Chapter one) Tj EMC ET Q')));
  const h = structElem(ctx, { role: 'H', parent: rootRef, page, k: 0 });
  root.set(PDFName.of('K'), ctx.obj([h]));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([h])] })));
  return doc.save();
}

async function makeXmpFixture({ compress = false, infoTitle = false } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  if (infoTitle) doc.setTitle('Metadata fixture');
  setMetadata(doc, 'Metadata fixture', { compress });
  return doc.save();
}

async function makeClean() {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Clean fixture', withResources: false });
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 0 0 1 1 re f Q')));
  const h1 = structElem(ctx, { role: 'H1', parent: rootRef, actualText: 'Clean fixture title' });
  const figure = structElem(ctx, { role: 'Figure', parent: rootRef, alt: 'A decorative rule.' });
  root.set(PDFName.of('K'), ctx.obj([h1, figure]));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([])] })));
  root.set(PDFName.of('RoleMap'), ctx.obj({}));
  setMetadata(doc, 'Clean fixture');
  doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));
  return doc.save();
}


const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function makeAnnotations() {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Annotation fixture', withResources: false });
  const note = ctx.register(ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: ctx.obj([72, 700, 96, 724]),
    Contents: PDFString.of('A note'),
  }));
  const trap = ctx.register(ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('TrapNet'),
    Rect: ctx.obj([72, 600, 96, 624]),
  }));
  page.node.set(PDFName.of('Annots'), ctx.obj([note, trap]));
  const p = structElem(ctx, { role: 'P', parent: rootRef, actualText: 'Body' });
  root.set(PDFName.of('K'), ctx.obj([p]));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([])] })));
  return doc.save();
}

async function makeTitleMismatch() {
  const doc = await PDFDocument.create();
  const { ctx, root, rootRef } = basePageDoc(doc, { title: 'Annual Budget Report', withResources: false });
  const h1 = structElem(ctx, { role: 'H1', parent: rootRef, actualText: 'Budget Book 2024' });
  root.set(PDFName.of('K'), ctx.obj([h1]));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([])] })));
  return doc.save();
}

async function makeImageTagging({ artifactOnly = false } = {}) {
  const doc = await PDFDocument.create();
  const { page, ctx, root, rootRef } = basePageDoc(doc, { title: 'Image tagging fixture', withResources: true });
  const image = await doc.embedPng(TINY_PNG);
  page.drawImage(image, { x: 40, y: 40, width: 60, height: 60 });
  const xobjects = page.node.Resources().lookup(PDFName.of('XObject'));
  const name = [...xobjects.dict.keys()][0].asString().replace(/^\//, '');
  const lines = [
    'q',
    'BT /F1 12 Tf 72 740 Td',
    '/P <</MCID 0>> BDC',
    '(Body text for the image tagging fixture.) Tj',
    'EMC',
    'ET',
    '100 0 0 100 40 600 cm',
    '/Artifact BMC',
    `/${name} Do`,
    'EMC',
    ...(artifactOnly ? ['100 0 0 100 40 450 cm', '/Artifact BMC', `/${name} Do`, 'EMC'] : ['100 0 0 100 40 450 cm', `/${name} Do`]),
    'Q',
  ];
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(lines.join('\n'))));
  const p = structElem(ctx, { role: 'P', parent: rootRef, k: 0 });
  root.set(PDFName.of('K'), ctx.obj([p]));
  root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: [0, ctx.obj([p])] })));
  return doc.save();
}

export async function makeFixtures(dir) {
  await fs.mkdir(dir, { recursive: true });
  const untaggedDoc = await PDFDocument.create();
  untaggedDoc.setTitle('Untagged fixture');
  const page = untaggedDoc.addPage([612, 792]);
  page.drawText('An untagged budget document.', { x: 72, y: 720, size: 14 });
  const scannedDoc = await PDFDocument.create();
  scannedDoc.setTitle('Scanned fixture');
  const scannedPage = scannedDoc.addPage([612, 792]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = await scannedDoc.embedPng(png);
  scannedPage.drawImage(image, { x: 72, y: 500, width: 200, height: 200 });
  const files = {
    untagged: path.join(dir, 'untagged.pdf'),
    taggedGood: path.join(dir, 'tagged-good.pdf'),
    taggedBad: path.join(dir, 'tagged-bad.pdf'),
    scanned: path.join(dir, 'scanned.pdf'),
    artifact: path.join(dir, 'artifact.pdf'),
    orphan: path.join(dir, 'orphan.pdf'),
    formTree: path.join(dir, 'form-tree.pdf'),
    headersId: path.join(dir, 'headers-id.pdf'),
    spans: path.join(dir, 'spans.pdf'),
    strongH: path.join(dir, 'strong-h.pdf'),
    xmpOnlyTitle: path.join(dir, 'xmp-only-title.pdf'),
    compressedXmp: path.join(dir, 'compressed-xmp.pdf'),
    clean: path.join(dir, 'clean.pdf'),
    annotations: path.join(dir, 'annotations.pdf'),
    titleMismatch: path.join(dir, 'title-mismatch.pdf'),
    images: path.join(dir, 'images.pdf'),
    imagesArtifact: path.join(dir, 'images-artifact.pdf'),
  };
  await fs.writeFile(files.untagged, await untaggedDoc.save());
  await fs.writeFile(files.taggedGood, await makeTagged(true));
  await fs.writeFile(files.taggedBad, await makeTagged(false));
  await fs.writeFile(files.scanned, await scannedDoc.save());
  await fs.writeFile(files.artifact, await makeMarkedContent({}));
  await fs.writeFile(files.orphan, await makeMarkedContent({ orphan: true }));
  await fs.writeFile(files.formTree, await makeFormTree());
  await fs.writeFile(files.headersId, await makeTableFixture('headers-id'));
  await fs.writeFile(files.spans, await makeTableFixture('spans'));
  await fs.writeFile(files.strongH, await makeStrongH());
  await fs.writeFile(files.xmpOnlyTitle, await makeXmpFixture({}));
  await fs.writeFile(files.compressedXmp, await makeXmpFixture({ compress: true, infoTitle: true }));
  await fs.writeFile(files.clean, await makeClean());
  await fs.writeFile(files.annotations, await makeAnnotations());
  await fs.writeFile(files.titleMismatch, await makeTitleMismatch());
  await fs.writeFile(files.images, await makeImageTagging({}));
  await fs.writeFile(files.imagesArtifact, await makeImageTagging({ artifactOnly: true }));
  return files;
}

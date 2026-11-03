/**
 * Deterministic PDF fixtures for the auditor tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

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
  };
  await fs.writeFile(files.untagged, await untaggedDoc.save());
  await fs.writeFile(files.taggedGood, await makeTagged(true));
  await fs.writeFile(files.taggedBad, await makeTagged(false));
  await fs.writeFile(files.scanned, await scannedDoc.save());
  return files;
}

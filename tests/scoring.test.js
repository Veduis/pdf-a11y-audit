import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScores } from '../src/audit.js';

function stat(occurrences) {
  return { occurrences, pages: new Set(), instances: [], evidenceSample: null };
}

function scores(entries) {
  return computeScores({ stats: new Map(Object.entries(entries)) });
}

test('penalties are capped per rule so a systemic defect cannot auto-zero', () => {
  const result = scores({ 'figures.missing-alt': stat(50) });
  // weight 8, cap 2
  assert.equal(result.blockingPenalty, 16);
  assert.equal(result.blockingScore, 84);
  assert.equal(result.status, 'fail');
});

test('page-level defects are charged once regardless of page count', () => {
  const one = scores({ 'pages.scanned': stat(1) });
  const many = scores({ 'pages.scanned': stat(300) });
  assert.equal(one.blockingPenalty, many.blockingPenalty);
  assert.equal(many.blockingScore, 80);
});

test('grouped root causes are not double-charged', () => {
  const result = scores({
    'pdfua.marked': stat(1),
    'pdfua.parent-tree': stat(1),
    'pdfua.suspects': stat(1),
    'pdfua.rolemap': stat(2),
  });
  // structure group takes the worst (12), rolemap is separate (5)
  assert.equal(result.blockingPenalty, 17);
});

test('metadata group takes the worst of stream and title', () => {
  const result = scores({ 'pdfua.xmp-title': stat(1), 'pdfua.metadata-stream': stat(1) });
  assert.equal(result.blockingPenalty, 6);
});

test('information rules never affect either score', () => {
  const result = scores({ 'headings.multiple-h1': stat(3), 'pdfua.title': stat(1) });
  assert.equal(result.blockingPenalty, 0);
  assert.equal(result.polishPenalty, 0);
  assert.equal(result.blockingScore, 100);
  assert.equal(result.polishScore, 100);
  assert.equal(result.status, 'pass');
});

test('advisory findings cannot round a report up to a perfect polish score', () => {
  const result = scores({ 'figures.filename-alt': stat(1) });
  assert.equal(result.polishPenalty, 1);
  assert.equal(result.polishScore, 99);
  assert.equal(result.status, 'review');
});

test('missing structure is a blocking finding on its own', () => {
  const result = scores({ 'pdfua.tagged': stat(1) });
  assert.equal(result.blockingScore, 70);
  assert.equal(result.status, 'fail');
});

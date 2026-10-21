import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readEvaluationReportArchive } from '../../workflow/lib/evaluation-artifact.mjs';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipReport(report, entryName = 'evaluation/evaluation-report.json', method = 8) {
  const name = Buffer.from(entryName);
  const contents = Buffer.from(JSON.stringify(report));
  const compressed = method === 8 ? deflateRawSync(contents) : contents;
  const checksum = crc32(contents);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test('evaluation artifact reader accepts the exact single-file JSON report', () => {
  const report = { type: 'evaluation-report', data: { correctness: { checks_result: 'success' } } };
  assert.deepEqual(readEvaluationReportArchive(zipReport(report)), report);
  assert.deepEqual(readEvaluationReportArchive(zipReport(report, undefined, 0)), report);
});

test('evaluation artifact reader rejects path changes and corrupt ZIP integrity data', () => {
  const report = { type: 'evaluation-report' };
  assert.throws(() => readEvaluationReportArchive(zipReport(report, '../evaluation-report.json')), {
    code: 'EVALUATION_ARTIFACT_INVALID',
  });
  const corrupt = zipReport(report);
  corrupt[corrupt.length - 22 - 46 - Buffer.byteLength('evaluation/evaluation-report.json') + 16] ^=
    1;
  assert.throws(() => readEvaluationReportArchive(corrupt), {
    code: 'EVALUATION_ARTIFACT_INVALID',
  });
});

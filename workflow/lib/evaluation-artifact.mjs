import { inflateRawSync } from 'node:zlib';
import { WorkflowError } from './support.mjs';

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const ENTRY_NAME = 'evaluation/evaluation-report.json';
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function invalid(message) {
  throw new WorkflowError('EVALUATION_ARTIFACT_INVALID', message);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function readEvaluationReportArchive(value) {
  const archive = Buffer.from(value);
  if (archive.length > MAX_ARCHIVE_BYTES)
    invalid('The Actions artifact archive exceeds the size limit.');
  const searchStart = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) invalid('The Actions artifact is not a supported ZIP archive.');
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== 1 ||
    entryCount !== 1 ||
    centralSize < 46 ||
    centralOffset + 46 > endOffset ||
    centralOffset + centralSize > endOffset ||
    endOffset + 22 + commentLength !== archive.length
  )
    invalid('The Actions artifact must contain exactly one non-ZIP64 report file.');
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50)
    invalid('The Actions artifact central directory is invalid.');
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const entryCommentLength = archive.readUInt16LE(centralOffset + 32);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const name = archive.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength);
  if (
    name !== ENTRY_NAME ||
    flags & 1 ||
    ![0, 8].includes(method) ||
    compressedSize > MAX_REPORT_BYTES ||
    uncompressedSize > MAX_REPORT_BYTES ||
    centralOffset + 46 + nameLength + extraLength + entryCommentLength !==
      centralOffset + centralSize
  )
    invalid('The Actions artifact does not contain the expected safe report entry.');
  if (localOffset + 30 > centralOffset)
    invalid('The Actions artifact local file header is outside the archive entry area.');
  if (archive.readUInt32LE(localOffset) !== 0x04034b50)
    invalid('The Actions artifact local file header is invalid.');
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  if (
    localName !== ENTRY_NAME ||
    localFlags !== flags ||
    localFlags & 1 ||
    dataOffset + compressedSize > centralOffset ||
    archive.readUInt16LE(localOffset + 8) !== method
  )
    invalid('The Actions artifact local entry does not match its central directory.');
  let contents;
  try {
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    contents =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_REPORT_BYTES });
  } catch {
    invalid('The Actions artifact report could not be safely decompressed.');
  }
  if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc)
    invalid('The Actions artifact report failed its ZIP integrity check.');
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    invalid('The Actions artifact report is not valid UTF-8 JSON.');
  }
}

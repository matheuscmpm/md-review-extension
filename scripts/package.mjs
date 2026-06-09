/**
 * scripts/package.mjs — Creates distributable browser packages for the extension.
 *
 * Run:  npm run package
 * Output: dist/markdown-rich-review-<version>.zip
 *         dist/markdown-rich-review-firefox-<version>.xpi
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const target = (process.argv[2] || "all").toLowerCase();

// Files/directories to include in the extension package
const INCLUDE = [
  "manifest.json",
  "background.js",
  "content-script.js",
  "utils/",
  "styles/",
  "icons/",
  "popup.html",
  "popup.js",
  "LICENSE",
];

mkdirSync(DIST, { recursive: true });

// Collect all files from the include list
function collectFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const fullPath = join(ROOT, entry);
    const stat = statSync(fullPath, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      const items = readdirSync(fullPath, { recursive: true });
      for (const item of items) {
        const itemPath = join(fullPath, item);
        if (statSync(itemPath).isFile()) {
          files.push({ path: itemPath, name: relative(ROOT, itemPath).replace(/\\/g, "/") });
        }
      }
    } else {
      files.push({ path: fullPath, name: relative(ROOT, fullPath).replace(/\\/g, "/") });
    }
  }
  return files;
}

// Minimal ZIP file builder (Store method — no compression needed for small files)
function createZipBuffer(files) {
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.path);
    const nameBytes = Buffer.from(file.name, "utf8");
    const now = new Date();

    const dosTime =
      ((now.getSeconds() >> 1) | (now.getMinutes() << 5) | (now.getHours() << 11)) & 0xffff;
    const dosDate =
      (now.getDate() | ((now.getMonth() + 1) << 5) | ((now.getFullYear() - 1980) << 9)) & 0xffff;

    // CRC-32
    const crc = crc32(data);

    // Local file header (30 + name length)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);     // signature
    localHeader.writeUInt16LE(20, 4);              // version needed
    localHeader.writeUInt16LE(0, 6);               // flags
    localHeader.writeUInt16LE(0, 8);               // compression (Store)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);    // compressed size
    localHeader.writeUInt32LE(data.length, 22);    // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);              // extra length
    nameBytes.copy(localHeader, 30);

    entries.push({ localHeader, data, nameBytes, crc, dosTime, dosDate, offset });
    offset += localHeader.length + data.length;
  }

  // Central directory
  const centralParts = [];
  for (const entry of entries) {
    const cd = Buffer.alloc(46 + entry.nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);               // signature
    cd.writeUInt16LE(20, 4);                        // version made by
    cd.writeUInt16LE(20, 6);                        // version needed
    cd.writeUInt16LE(0, 8);                         // flags
    cd.writeUInt16LE(0, 10);                        // compression
    cd.writeUInt16LE(entry.dosTime, 12);
    cd.writeUInt16LE(entry.dosDate, 14);
    cd.writeUInt32LE(entry.crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);        // compressed
    cd.writeUInt32LE(entry.data.length, 24);        // uncompressed
    cd.writeUInt16LE(entry.nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);                        // extra
    cd.writeUInt16LE(0, 32);                        // comment
    cd.writeUInt16LE(0, 34);                        // disk start
    cd.writeUInt16LE(0, 36);                        // internal attrs
    cd.writeUInt32LE(0, 38);                        // external attrs
    cd.writeUInt32LE(entry.offset, 42);             // local header offset
    entry.nameBytes.copy(cd, 46);
    centralParts.push(cd);
  }

  const centralDir = Buffer.concat(centralParts);
  const centralDirOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                         // disk
  eocd.writeUInt16LE(0, 6);                         // disk with CD
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);                        // comment length

  const allLocalData = entries.flatMap((e) => [e.localHeader, e.data]);
  return Buffer.concat([...allLocalData, centralDir, eocd]);
}

// CRC-32 lookup table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const files = collectFiles(INCLUDE);
console.log(`Packaging ${files.length} files for target: ${target}...`);
files.forEach((f) => console.log(`  ${f.name}`));

const zipBuffer = createZipBuffer(files);
const packages = {
  chrome: { name: `markdown-rich-review-${version}.zip`, label: "Chrome / Edge" },
  firefox: { name: `markdown-rich-review-firefox-${version}.xpi`, label: "Firefox" },
};

const targets = target === "all"
  ? Object.keys(packages)
  : Object.keys(packages).filter((name) => name === target);

if (!targets.length) {
  throw new Error(`Unknown packaging target "${target}". Use one of: all, chrome, firefox.`);
}

for (const packageTarget of targets) {
  const packagePath = join(DIST, packages[packageTarget].name);
  writeFileSync(packagePath, zipBuffer);
  console.log(
    `\n✅ ${packages[packageTarget].label} package: ${packagePath} (${(zipBuffer.length / 1024).toFixed(1)} KB)`
  );
}

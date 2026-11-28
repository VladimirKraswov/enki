import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
const assets=path.resolve('dist/assets');
const files=fs.readdirSync(assets);
for(const [pattern,rawLimit,gzipLimit] of [
 [/^index-.*\.js$/,450_000,130_000],
 [/^SettingsScreen-.*\.js$/,150_000,40_000],
 [/^pdfjs-.*\.js$/,520_000,160_000],
 [/^syntax-highlight-.*\.js$/,100_000,35_000],
 [/^markdown-vendor-.*\.js$/,180_000,55_000],
]){
 const names=files.filter(f=>pattern.test(f));if(names.length!==1)throw Error(`Expected exactly one chunk: ${pattern}`);
 const bytes=fs.readFileSync(path.join(assets,names[0])),gzip=gzipSync(bytes).length;
 console.log(`${names[0]}: ${bytes.length} bytes, gzip ${gzip}`);
 if(bytes.length>rawLimit||gzip>gzipLimit)throw Error('Bundle regression: inspect eager imports before increasing the measured budget.');
}

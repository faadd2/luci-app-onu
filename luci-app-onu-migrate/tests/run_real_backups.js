// 向导页实测（Node 侧）：用真实 PT1570 备份文件跑生产 parser.js
'use strict';
const fs = require('fs');
const path = require('path');
const parser = require(path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'onu-migrate', 'parser.js'));

const files = process.argv.slice(2);
let failures = 0;

for (const f of files) {
  const text = fs.readFileSync(f, 'utf-8');
  const fmt = parser.detectFormat(text);
  console.log('\n=== ' + path.basename(f) + ' ===');
  console.log('detectFormat: ' + fmt);
  const model = parser.parseConfigImport(text);
  if (model.error) {
    console.log('ERROR: ' + model.error);
    failures++;
  }
  console.log(JSON.stringify(parser.preview(model), null, 2));
}

process.exit(failures ? 1 : 0);

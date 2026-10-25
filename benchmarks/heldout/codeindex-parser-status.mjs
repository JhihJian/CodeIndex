import fs from 'node:fs';
import { loadIndex } from '../../src/index.js';

const [store, corpus, caseFile] = process.argv.slice(2);
const index = loadIndex(store);
try {
  const byLanguageAndStatus = index.db.prepare('SELECT language,parse_status,count(*) AS files FROM files GROUP BY language,parse_status ORDER BY language,parse_status').all();
  const errors = index.db.prepare('SELECT path,language,parse_status,parse_error FROM files WHERE parse_error IS NOT NULL ORDER BY path').all();
  const callerDefinitions = JSON.parse(fs.readFileSync(caseFile, 'utf8'))[corpus].map((test) => ({
    caller: test.caller, path: test.path,
    matches: index.findSymbols({ name: test.caller, path: test.path, limit: 100 })
      .map(({ name, kind, sourceSpan }) => ({ name, kind, sourceSpan })),
  }));
  console.log(JSON.stringify({ byLanguageAndStatus, errors, callerDefinitions }, null, 2));
} finally { index.close(); }

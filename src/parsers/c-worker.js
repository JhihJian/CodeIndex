import { parseC } from './c.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const entries = JSON.parse(input);
  const results = [];
  for (const entry of entries) {
    try {
      results.push(parseC(entry));
    } catch (error) {
      results.push({ path: entry.path, status: 'partial', error: `c-parser:${error.message}`, symbols: [], relations: [] });
    }
  }
  process.stdout.write(JSON.stringify(results));
});

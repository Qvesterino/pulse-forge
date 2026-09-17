import { parseIntentText } from '../src/intent/text-parser.ts';
const tests = [
  'dark rolling techno at 140',
  'sparse ambient chill',
  'aggressive driving trap with lead',
  'house deep 124 bpm',
  'drums only complex',
];
for (const t of tests) {
  const r = parseIntentText(t);
  console.log(t, '→', JSON.stringify({...r.input}), 'detected:', r.detected.join(','));
}

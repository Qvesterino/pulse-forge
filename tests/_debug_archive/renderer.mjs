import { expandAutomationAcrossWindows } from './src/rendering/renderer.ts';
import { STEP_TICKS } from './src/project-model/types.ts';

const pattern = { id: 'p', name: 'P', stepCount: 16, rows: {}, notes: {} };
const points = [
  { tick: 0, value: 0 },
  { tick: 15 * STEP_TICKS, value: 0.9 },
];
const result = expandAutomationAcrossWindows(points, [
  { pattern, base: 0, from: 0, to: 24 * STEP_TICKS },
]);
console.log('result:', JSON.stringify(result, null, 2));
console.log('expected length:', 3);
console.log('actual length:', result.length);
console.log('STEP_TICKS:', STEP_TICKS);
console.log('24 * STEP_TICKS:', 24 * STEP_TICKS);
console.log('patternTicks:', pattern.stepCount * STEP_TICKS);
console.log('cycles:', Math.max(1, Math.ceil((24 * STEP_TICKS) / (pattern.stepCount * STEP_TICKS))));

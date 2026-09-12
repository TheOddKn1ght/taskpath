import { pickerChecks } from './browser-picker-checks.js';
const output = document.querySelector<HTMLElement>('#result')!;
const results: string[] = [];
try {
  await pickerChecks((condition, message) => {
    if (!condition) throw new Error(message);
    results.push('PASS ' + message); output.textContent = results.join('\n');
  });
  output.textContent += `\nALL ${results.length} PICKER CHECKS PASSED`;
} catch (error) { output.textContent += '\nFAIL ' + (error instanceof Error ? error.stack : String(error)); }

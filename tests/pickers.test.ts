import { expect, test } from 'bun:test';
import { matchingOptions, monthDays, shiftDate, shiftMonth, validCalendarDate } from '../public/picker-model.js';
import { localReminderValue, reminderFromInput } from '../public/dates.js';

test('picker calendar validates exact calendar dates without timezone normalization', () => {
  for (const day of ['0001-01-01', '2024-02-29', '2026-12-31', '9999-12-31']) expect(validCalendarDate(day)).toBe(true);
  for (const day of ['', '0000-01-01', '2026-02-29', '2026-04-31', '2026-1-01', '2026-13-01']) expect(validCalendarDate(day)).toBe(false);
  expect(monthDays('2026-09-12').slice(0, 8)).toEqual([null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
  expect(monthDays('2021-02-01')).toHaveLength(28);
  expect(monthDays('2026-03-01')).toHaveLength(42);
});
test('picker keyboard navigation crosses month/year boundaries and clamps month days', () => {
  expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29');
  expect(shiftMonth('2024-01-31', 1)).toBe('2024-02-29');
  expect(shiftMonth('2026-03-31', -1)).toBe('2026-02-28');
  expect(shiftDate('0001-01-01', -1)).toBe('0001-01-01');
  expect(shiftDate('9999-12-31', 1)).toBe('9999-12-31');
  expect(shiftMonth('9999-12-31', 1)).toBe('9999-12-31');
});
test('picker option search handles Unicode, spaces, disabled choices and empty results', () => {
  const options = [{label:'Café', value:'coffee'}, {label:'Home office', value:'home', disabled:true}];
  expect(matchingOptions(options, ' CAFE\u0301 ')).toEqual([options[0]]);
  expect(matchingOptions(options, 'office')).toEqual([options[1]]);
  expect(matchingOptions(options, '')).toEqual(options);
  expect(matchingOptions(options, 'missing')).toEqual([]);
});
test('reminder picker formats minute inputs and rejects missing or invalid times', () => {
  const original = '2026-09-12T10:07:43.123Z';
  const value = localReminderValue(original);
  expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  expect(() => reminderFromInput(value.slice(0, 10) + 'T')).toThrow();
  expect(() => reminderFromInput(value.slice(0, 10) + 'T25:00')).toThrow();
});

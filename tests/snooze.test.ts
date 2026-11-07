import { expect, test } from 'bun:test';
import { ClientStore } from './client-helpers';

for (const minutes of [5, 10, 30, 60, 180, 1440, undefined]) {
  test(`snooze ${minutes ?? 'default'} minutes rearms from now and survives projection`, () => {
    const now = new Date('2026-11-07T12:00:00Z');
    const store = new ClientStore(':memory:', () => now);
    const task = store.create({ title: 'Reminder', reminderAt: '2026-11-06T09:00:00Z' });
    now.setTime(now.getTime() + 1000);
    const result = store.actOnReminder(task.id, {
      action: 'snooze',
      reminderAt: task.reminderAt,
      snoozeMinutes: minutes,
    });
    expect(result.reminderAt).toBe(new Date(now.getTime() + (minutes ?? 10) * 60000).toISOString());
    expect(result.reminderToken).not.toBe(task.reminderToken);
    expect(result.title).toBe(task.title);
    expect(store.board().reminders).toHaveLength(0);
    expect(() =>
      store.actOnReminder(task.id, { action: 'dismiss', reminderAt: task.reminderAt }),
    ).toThrow('changed');
  });
}

test('unsupported snooze durations leave the reminder intact', () => {
  const store = new ClientStore();
  const task = store.create({ title: 'Reminder', reminderAt: '2026-01-01T00:00:00Z' });
  for (const snoozeMinutes of [0, -5, 15, '30', null]) {
    expect(() =>
      store.actOnReminder(task.id, {
        action: 'snooze',
        reminderAt: task.reminderAt,
        snoozeMinutes,
      }),
    ).toThrow('supported snooze');
    expect(store.syncBoard().rows.find((row) => row.id === task.id)?.reminderAt).toBe(
      task.reminderAt,
    );
  }
});

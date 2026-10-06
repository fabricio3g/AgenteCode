import { setReminderNotifier, startReminderScheduler, type Reminder } from '$lib/services/home-productivity';
import { toastStore } from '$lib/stores/toast.svelte';

/** Shows due reminders as a toast (and a system notification if already permitted), then re-arms pending ones. */
export function startReminders(): void {
  setReminderNotifier((reminder: Reminder) => {
    toastStore.info(`Reminder: ${reminder.text}`, 12000);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Reminder', { body: reminder.text });
    } catch {
      /* the toast already showed it */
    }
  });
  startReminderScheduler();
}

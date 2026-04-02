/**
 * notificationWorker — Zeebe job worker for trialo:send-notification service tasks.
 */
import axios from 'axios';
import { config } from '../config';

export interface NotificationJobVariables {
  org_id: string;
  notification_type?: string;
  title?: string;
  body?: string;
  recipient_id?: string;
  severity?: string;
  [key: string]: unknown;
}

export async function sendNotificationForJob(variables: NotificationJobVariables): Promise<Record<string, unknown>> {
  try {
    await axios.post(`${config.notificationServiceUrl}/notifications/send`, {
      org_id: variables.org_id,
      user_id: variables.recipient_id,
      notification_type: variables.notification_type || 'workflow_alert',
      severity: variables.severity || 'info',
      title: variables.title || 'Workflow Notification',
      body: variables.body || 'A workflow action requires your attention.',
    });
    return { notification_sent: true };
  } catch (err) {
    console.warn('[notificationWorker] Send failed:', err);
    return { notification_sent: false, notification_error: String(err) };
  }
}

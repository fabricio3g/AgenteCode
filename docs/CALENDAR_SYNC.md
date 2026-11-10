# Calendar sync in Agente Desktop

Open **Calendar → Add calendar**. **Subscribe by link** accepts a public HTTPS or webcal iCalendar feed. For Google Calendar, copy the **Secret address in iCal format** from **Settings → Integrate calendar**. Treat that link as a credential. Agente encrypts subscription links and sign-in tokens using the operating system. A subscription is read-only.

## Enable account sign-in

Set these variables in the environment that launches Desktop. Leave a provider’s variables unset to offer link subscriptions without that provider’s account sign-in.

| Provider | Environment | Registration |
| --- | --- | --- |
| Google Calendar | `AGENTE_GOOGLE_CALENDAR_CLIENT_ID` and `AGENTE_GOOGLE_CALENDAR_CLIENT_SECRET` | Enable the Calendar API and create a **Desktop app** OAuth client. Configure the consent screen and prepare the scopes for public distribution. |
| Outlook | `AGENTE_OUTLOOK_CALENDAR_CLIENT_ID` | Register a Microsoft Entra public client for the account types you support. Register `http://127.0.0.1/callback` as a mobile/desktop redirect URI. Microsoft documents registering HTTP loopback IP addresses through the app manifest when the portal rejects them. |

Both providers use the system browser, PKCE, and a temporary loopback callback. Google uses read-only calendar-list and event scopes. Outlook uses delegated `Calendars.ReadBasic` and offline access. Account selection and API setup are independent of Agente’s Google Workspace bridge.

Synced events appear in Calendar, its sidebar preview, and Home’s upcoming list. Agente stores event names and dates locally for offline display. Removing a calendar clears its cache and removes the stored credentials when it was the last calendar on that connection. The provider’s account settings also let users revoke the app’s consent.

- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Microsoft desktop app registration](https://learn.microsoft.com/entra/identity-platform/scenario-desktop-app-registration)
- [Microsoft loopback redirect rules](https://learn.microsoft.com/entra/identity-platform/reply-url#loopback-ip-addresses)

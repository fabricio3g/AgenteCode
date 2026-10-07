# Google Docs, Sheets and Drive

The `web_doc_*`, `web_sheet_*` and `web_drive_*` tools reach your Google files in one of two ways:

- **Through your browser (no setup).** With the Agente extension connected, `doc_read` and `sheet_read` read the doc or sheet open in your tab using the session you are already signed in with. This path is read-only.
- **Through Google's APIs (one-time setup).** This is needed for writing: `doc_edit`, `doc_create`, `sheet_write`, `sheet_format`, `sheet_create` and `drive_push`. It also gives better reads, including formulas and structured documents.

## One-time setup (about five minutes)

Agente uses **your own** OAuth client, so your tokens never pass through anyone else's app.

1. Open <https://console.cloud.google.com/>, then create a project (any name).
2. **APIs & Services → Library**: enable the **Google Docs API**, the **Google Sheets API** and the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, then fill in the app name and your email. Under **Test users**, add your own Google account. Testing mode is fine; you never need to publish.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, then choose **Desktop app**.
5. Copy the client ID and client secret, then run:

```bash
agente bridge auth google --client-id YOUR_ID.apps.googleusercontent.com --client-secret YOUR_SECRET
```

A browser tab opens. Approve the access, and you are done. The client is stored in `~/.agente/bridge.json`, and the token in Agente's auth store (`~/.agente/auth.json`), where it renews itself. Run `agente bridge status` to check.

## Scopes

| Scope | Why |
|---|---|
| `documents` | Read and edit Google Docs |
| `spreadsheets` | Read and write Google Sheets |
| `drive.readonly` | Find and download files you can already open |
| `drive.file` | Upload new files (Agente can only modify files it created this way) |

To revoke access, go to <https://myaccount.google.com/permissions>.

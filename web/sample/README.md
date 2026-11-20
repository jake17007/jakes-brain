# Jake’s Brain sample finances

Open `/sample/index.html#/` for the familiar launcher, then tap Finances. The financial balances, history, accounts, transactions, goal and editable budget are synthetic. They live in this page’s memory and reset on reload.

The persistent **Return to real app** link opens `/#/finances` on the canonical app origin. Real app sign-in and the Finance lock continue to work normally. The real Finances options menu has an **Open sample version** shortcut.

## Isolation boundary

The sample web finance module does not read or write live financial APIs, records, credentials, PIN/Face ID keys, or persistent browser storage. Its API helper calls only `sample-data.js` in memory. Content Security Policy blocks fetch/XHR/WebSocket connections (`connect-src 'none'`). Static files still load through the existing signed-in app gateway. No backend, authentication, native app, service worker or real financial records were changed.

The existing native iPhone wrapper may continue its normal ReminderScheduler activity, including reminder requests and notification/UserDefaults updates. Page CSP does not govern native URLSession. This package therefore makes **no claim that the entire native app performs zero API or storage operations**; the isolation guarantee applies to the new sample web finance data path.

The launcher retains the real app layout. Only Finances is implemented in this sample; other tiles direct you back to the real app.

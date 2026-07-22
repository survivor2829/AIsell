AI Customer Auto Reply Live Listener

Purpose:
This is a read-only listener used to locate cross-computer auto-reply failures.
It does not click WeChat, type text, call an AI API, or send messages.

Steps:
1. Extract the ZIP to a normal folder.
2. Keep WeChat and AI Customer open.
3. Start auto reply in AI Customer.
4. Double-click Start-Live-Listener.cmd.
5. During the three-minute capture, send two short test messages from the test account.
6. Do not manually switch WeChat conversations during capture.
7. When the console reports completion, send the AutoReply-Live-Trace-*.zip created on the Desktop.

Collected evidence:
- A timestamped screenshot of the WeChat window every two seconds.
- Window handle, bounds, DPI, foreground state, and image hash.
- Unread badge component geometry and pass/fail classification.
- Auto-reply state and diagnostic transitions.
- Periodic UI Automation snapshots when available.

The listener does not collect API keys, WeChat databases, or unrelated desktop screenshots.

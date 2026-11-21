# Telegram admin navigation

The private admin chat should work without copying account IDs or typing commands. Show one account per full-width button, then show its full ID, status, dates, and applicable actions on a detail screen. Keep account names private: the bot only uses server-visible IDs and status.

Menu, account list, and detail navigation update the current message to avoid flooding the chat. Mutation results and disable confirmations remain separate messages so invitation links and action outcomes remain available. Every result or error offers navigation back to Accounts or the main menu. Keep slash commands available.

Disabling still requires a short-lived, single-use confirmation bound to its message. Navigation must not bypass authorization or replay account changes after a delivery failure. If a navigation edit is rejected because the message is unchanged, treat it as successful; other rejected edits can fall back to a new message.

Key sources: `src/telegram.ts` and `tests/telegram.test.ts`.

Account details show file usage, effective quota, and whether it inherits the server default. A quota screen offers common MB values, zero, and reset; `/quota USER_ID [MB|default]` supports inspection and custom whole-MB values. Quota mutations use the same private-chat authorization and durable update consumption as other admin actions.

The separate File size limit screen and `/filelimit USER_ID [MB|default]` manage each account’s per-file allowance, defaulting to 10 MB with a 1,000 MB ceiling. Account details show both total quota and per-file allowance.

The home screen summarizes account status and keeps the command reference under Help. The account directory filters by status and returns from an account to its position in the selected list. Distinguish pending invitations with a usable link from expired or revoked links. Use Telegram formatting, localized dates, and labeled buttons that remain understandable without color.

Keep the full setup URL in the invitation message and offer one-tap copying when it fits Telegram's clipboard limit. Opening the dashboard or account from a receipt should leave the receipt available in chat. Storage presets share compact rows and mark the saved override or inherited default. Lowering either limit retains previously stored files.

For a custom storage limit, prompt for the number of MB in the same private chat. Bind a numeric reply to the current prompt and its account and setting. Superseded prompts and prompts from a previous bot run cannot apply changes.

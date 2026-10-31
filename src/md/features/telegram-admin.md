# Telegram admin navigation

The private admin chat should work without copying account IDs or typing commands. Show one account per full-width button, then show its full ID, status, dates, and applicable actions on a detail screen. Keep account names private: the bot only uses server-visible IDs and status.

Menu, account list, and detail navigation update the current message to avoid flooding the chat. Mutation results and disable confirmations remain separate messages so invitation links and action outcomes remain available. Every result or error offers navigation back to Accounts or the main menu. Keep slash commands available.

Disabling still requires a short-lived, single-use confirmation bound to its message. Navigation must not bypass authorization or replay account changes after a delivery failure. If a navigation edit is rejected because the message is unchanged, treat it as successful; other rejected edits can fall back to a new message.

Key sources: `src/telegram.ts` and `tests/telegram.test.ts`.

# Using an outside warm-up service

rightnow’s built-in warm-up exchanges mail only between your own opted-in mailboxes. It does not simulate engagement. There is no built-in connection to an outside warm-up network, by design: those networks automate opens, replies and spam rescue, which rightnow will not build, and they may conflict with your mail provider’s terms. Using an outside service is your decision and your risk.

If you use one anyway:

1. Turn built-in warm-up off for that mailbox.
2. Connect the mailbox to the outside service using its own instructions.
3. Lower the mailbox’s daily limit in rightnow to make room. rightnow quotas count only rightnow sends; the service’s volume does not reduce them. The provider’s limit covers both. For example, with a limit of 100 messages a day and a service sending 30, set rightnow to 70 or less, and stay under half the provider cap.
4. Keep the service’s mail out of the inbox so it stays out of Inbox > Triage: add a filter at your mail provider on the service’s tag that skips the inbox.

## How sync sees service mail

Graph and IMAP read only Inbox and Sent. Gmail imports a message when it arrives with the `INBOX` or `SENT` label, or when it gains one later. Mail filtered past the inbox on arrival is not imported. Mail that lands in the inbox first is imported even if the service moves it later.

Copies the service sends in Sent are imported and appear in the Sent view as sent outside the app. They do not count toward rightnow quotas.

If the mail still reaches triage, you can turn off **Save emails from non-leads** in Settings. That also discards real replies from unknown addresses, including referrals, so use it only as a last resort.

The health score and placement tests measure campaign mail only. Judge the outside service by your own bounce and reply numbers.

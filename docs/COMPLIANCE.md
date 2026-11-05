# Compliance notes (PS-SEC-09 to -13)

These are engineering notes for the person running rightnow, not legal advice. The sender is responsible for the lists they upload and the mail they send. Ask a lawyer about your own case.

## What the software enforces

- **Authorized lists.** An import cannot start until the user confirms they have the right to contact the list (`confirmedAuthorized`, 400 otherwise) and picks a lawful basis. The import records `Lead.source` (`csv:<file>`) and `Lead.lawfulBasis`. The server also sets `Lead.uploadMethod` (`csv`, `manual` for the UI, `api` for a key); it cannot be supplied by the caller (PS-SEC-12).
- **Apollo sources.** Apollo imports require `confirmedAuthorized` and a lawful basis, record the source on each lead, and honor the blocklist and exclusions.
- **Honest sender identity.** A message can only be sent From the connected mailbox's own address; any other From is refused before it reaches the provider. No header spoofing, no invisible characters, no fake engagement (PS-SEC-16).
- **Unsubscribe.** Every campaign email carries a footer with the workspace's physical address and an unsubscribe link, plus `List-Unsubscribe` and (on https) `List-Unsubscribe-Post` headers. A workspace cannot send while its physical address is empty. An unsubscribe stops the lead's sequences and suppresses the address in the same transaction, and the suppression is durable.
- **Erasure.** `POST /leads/{id}/gdpr-delete` deletes the lead, its threads and messages, notes, webhook deliveries and AI suggestions, deletes or redacts events that hold the address, and keeps only a suppression row holding the sha256 of the address (`value` is null, reason `GDPR_ERASURE`), so the person is never mailed again. `GET /leads/{id}/export` returns everything held about one lead as JSON (access request). Both are audited.
- **Audit.** Sign-ins, account connect and disconnect, API key creation, exports, erasures, settings changes and member changes are in the audit log (Settings > Audit log).

## Operator responsibilities for Phase 9 integrations

Check that Apollo’s terms allow your use and have a lawful basis for people found through it. Referred leads are not enrolled automatically; contacting them is your decision. HubSpot does not receive later opt-outs or erasures, so apply them there yourself.

## By region

- **GDPR (EU/UK).** Cold B2B email needs a lawful basis, usually legitimate interest, with a way to object. Record the basis on import, honor objections through unsubscribe, and use the export and erasure routes for access and deletion requests. Keep the source field accurate: you may be asked where you got the address.
- **CAN-SPAM (US).** Not opt-in. Requires an accurate From, a truthful subject, a physical postal address, a working opt-out honored within 10 business days (here: at the next scheduler tick) and no purchased-list tricks. The footer and `List-Unsubscribe` cover the mechanics.
- **CASL (Canada).** Needs consent, express or implied, for commercial electronic messages. Implied consent is narrow (for example a published business address with no "no solicitation" notice and a relevant offer). Do not upload Canadian lists without it, and set the lawful basis accordingly.

## Not built

- An antivirus hook for inbound attachments (PS-SEC-15). Attachments are stored up to 25 MB, served only as downloads (`Content-Disposition: attachment`, `nosniff`, sandbox CSP) and never rendered inline.
- Consent receipts and double opt-in flows.

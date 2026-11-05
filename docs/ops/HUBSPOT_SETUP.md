# Connecting HubSpot

HubSpot is optional. It receives outreach contacts and deals from rightnow and supplies customer company domains for the blocklist.

## 1. Create a service key

In HubSpot, go to Development > Keys > Service keys. HubSpot's changelog also describes the path as Settings > Integrations > Service Keys; check which your account shows. Create a key with these scopes:

```
crm.objects.contacts.write
crm.objects.deals.read
crm.objects.deals.write
crm.objects.companies.read
crm.schemas.deals.read
crm.schemas.deals.write
```

HubSpot's documentation does not name a single scope for reading deal pipelines. If connecting returns `hubspot_scope`, compare the key's granted scopes with this list and your account's available scopes.

New legacy private apps cannot be created after 2026-10-26. Existing legacy private app tokens keep working, so either an existing token or a service key works here.

## 2. Connect in rightnow

In Settings > HubSpot, enter the service key and select **Load pipelines**. Choose a HubSpot pipeline. For each rightnow stage, choose the matching HubSpot stage or **Do not sync**, then select **Save HubSpot settings**. The key is write-only; rightnow never shows it again. To stop syncing, select **Disconnect** and confirm.

Use HubSpot as the master for customers and rightnow as the master for outreach deals. Turn off rightnow's built-in auto-deals (`positive_reply_opportunity`) only if you want no deals pushed.

## What syncs

Every five minutes, rightnow pushes contacts who replied, showed interest, or have a deal, plus mapped deals and stages. Once a day, it pulls domains of HubSpot companies whose `lifecyclestage` is `customer` onto the rightnow blocklist, up to HubSpot's 10,000-result search limit.

## What does not sync

- rightnow pushes changes to HubSpot. Changes made in HubSpot do not come back. A later rightnow change overwrites the same HubSpot deal fields.
- People who are blocked or opted out are not pushed. An opt-out or erasure after a push is **not sent to HubSpot; do that in HubSpot yourself**.
- Deleted deals are not removed from HubSpot.
- A company that is no longer a customer stays blocked until you remove its domain from the blocklist.

## Test before regular use

This integration has not yet been tested against a live HubSpot account. Run one contact and one deal through a test account first. In particular, confirm the `/crm/v3/pipelines/deals` path value works for your account and that upsert responses echo `rightnow_id`, which rightnow uses to match deals. Missing echoed IDs cause `hubspot_partial`.

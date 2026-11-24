# ADR 0006: WhatsApp numbers are message-only channels fed by signed notifications

- Status: Accepted
- Date: 2026-11-24

## Context

Clients want WhatsApp conversations in the same inbox as Messenger and
Instagram, with the same decide, draft, approve and send flow. The WhatsApp
Business Platform (Cloud API) differs from Meta's other messaging APIs in
ways that matter to the engine:

- There is no API to list conversations or read messages. An inbound message
  exists for the engine only in the webhook notification that carries it.
- A connection gives a WhatsApp Business Account (WABA) with one or more
  phone numbers; messages are sent from a number (`POST
  /{phone-number-id}/messages`). Numbers publish nothing.
- People are named by phone number (`wa_id`) and, since 2026, by a
  business-scoped user ID (`user_id`); a person with a username may come
  without a phone number.
- The 24-hour customer service window applies; outside it only an approved
  template may be sent.
- Each send can produce `sent`, `delivered`, `read` and `failed` status
  notifications, and a send can carry `biz_opaque_callback_data`, which every
  status of that message echoes.

Until now the engine trusted no content from notifications: the control
plane forwarded only Page and account IDs, and the engine read the
conversations itself.

## Decision

- **A platform and a kind.** WhatsApp is its own platform (`whatsapp`) with
  one channel kind (`whatsapp_number`, the phone number ID) and the messaging
  platform `whatsapp`. Its provider apps are records of their own (the same
  Meta app may be registered for `meta` and for `whatsapp`, each with its own
  Login for Business configuration), and connect through the same callback.
  The number's WABA is kept on the channel (`parent_external_id`).
- **Connecting.** Facebook Login for Business with
  `whatsapp_business_management` and `whatsapp_business_messaging` (a
  configuration that issues a system-user token is recommended: it does not
  expire). The grant's `whatsapp_business_management` targets name the WABAs;
  each of their numbers becomes a channel, and the app is subscribed to each
  WABA (`POST /{waba-id}/subscribed_apps`). An operator may instead connect
  one number with a token they hold (`POST /v1/tenants/:org/whatsapp/numbers`),
  checked against Meta before it is sealed like every other credential; there
  a refused subscription fails the connect.
- **Inbound content is trusted only under Meta's signature.** The control
  plane's public Meta webhook receiver forwards a WhatsApp notification as it
  came, with its `X-Hub-Signature-256` header, to `POST
  /v1/whatsapp/notifications`. The engine checks that signature again, with
  the secret of the provider app each named number was connected through, and
  ignores the changes of numbers whose app did not sign the body, or whose
  WABA is not the channel's. Only then does it read the content.
- **Durability.** The notification is the only copy, so the control plane
  forwards it before answering Meta and answers with an error when the engine
  did not store it; Meta then delivers it again (for up to 7 days). Storing is
  idempotent on the message ID (`wamid`). Unknown numbers, bad signatures and
  items that do not parse are acknowledged and counted, never retried.
- **Storage.** The same tables as Messenger and Instagram. A conversation is
  keyed by the person's business-scoped user ID, or by the phone number when
  Meta gives no ID (and stays keyed by it when an ID appears later); the phone
  number, when known, is the address a send uses. Media are kept as Meta's
  media ID and MIME type, never a URL, and read from Meta only when the
  control plane asks (`GET …/attachments/:index`). Kinds the engine does not
  answer (location, contacts, reactions, interactive and button replies,
  stickers, orders, system notices, unknown types) are stored with a
  readable placeholder as an attachment, which flags the message: the
  decision step never answers it automatically.
- **Sending.** Text only, inside the window; outside it the submission is
  refused with `409 outside_window` and `detail.templateRequired: true`.
  Template sends are left out. Each send carries the engine's outgoing
  message ID in `biz_opaque_callback_data`; once Meta accepts it, the engine
  records it in the conversation itself (nothing else will) and marks the
  person's last message as read.
- **Statuses.** `sent`, `delivered`, `read` and `failed` update the outgoing
  message's delivery status, forward only. A status that names an uncertain
  send by its outgoing ID settles it at the next look, without reading the
  platform; with no such report, the looks find nothing and a person decides
  after the 15-minute one, as elsewhere. A `failed` delivery after Meta
  accepted the message keeps the message `sent` and reports
  `deliveryStatus: failed` with a code: it was sent once and is never sent
  again.
- **Answering.** WhatsApp messages are direct messages (`kind: message`)
  with a 4,096-character limit; nothing else changes.

## Consequences

- The engine now stores content it did not read itself, but only content
  Meta signed with the app of the channel it is stored for. A compromised
  control plane can still submit messages to send (as before), but cannot
  forge inbound WhatsApp messages.
- The control plane's receiver needs the same app secret as the engine's
  WhatsApp provider app; a tenant-owned WhatsApp app with its own secret
  would need the receiver to know that secret too.
- If both the engine and Meta's retries are unavailable for more than 7
  days, those messages are lost: there is no API to read them back.
- Template messages, read receipts of the person's earlier messages and
  outbound media are not supported yet.

## Alternatives considered

- **Forward only IDs, as for Messenger.** There is nothing to read back.
- **Parse in the control plane and forward a normalized form.** The engine
  would trust the control plane's parsing and could not check Meta's
  signature.
- **WhatsApp numbers as `meta` channels.** One provider app record could not
  hold both the Pages configuration and the WhatsApp one, and the Meta
  adapter would carry a third kind with nothing in common with the others.

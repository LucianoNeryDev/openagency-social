# ADR 0004: The engine decides and drafts answers, and still sends only what was approved

- Status: Accepted
- Date: 2026-11-15
- Amended 2026-11-25: a risk question gates automatic answers (see
  [Amendment: risk gate](#amendment-risk-gate)).

## Context

Direct messages and comments wait for a person to read them and write an
answer in the control plane. Many need none (a thanks, an emoji), and many
ask what the brand has already written down (opening hours, shipping). The
control plane wants every inbound item sorted and, where it needs an answer,
a draft ready to approve; for some, an answer that goes out within minutes
without a person.

The engine already holds the inbound text and the channel context, and the
control plane already owns approval. Until now the engine held no model and
the boundary was simple: the code that reads comments and messages holds no
sending code, and nothing is sent that the control plane did not submit.

## Decision

The engine decides and drafts; it still sends only what the control plane
approved.

- **Settings.** The control plane pushes each tenant's resolved answering
  settings and preprogrammed context (`PUT /v1/tenants/:org/answering`,
  versioned). No settings, or `drafts` off: nothing happens, and a revision
  is refused. Items first seen before their kind was switched on are never
  processed.
- **A separate step.** The readers (conversation sync, comment reader) are
  unchanged: they store what they read and nothing else. A worker step that
  runs on its own schedule, after their commits, picks up new inbound rows
  that have no decision. It holds the models but no sending code; all it
  writes is one row per item (`inbound_drafts`) and an event for the control
  plane.
- **Decision.** One Choice question to Liquid AI's System One (`full`,
  `draft`, `none`), after `never` and `always` cases checked in code. The
  policy is the instruction; the item is state labelled as untrusted. A
  flagged item (a direct message with attachments) is asked but never
  `auto`. No key or a failed call is `skipped`: a person decides.
- **Draft.** Claude (Haiku 5.5 by default) with no tools and a structured
  JSON answer. Untrusted text is wrapped as escaped data; the brand's voice
  and context come from the control plane. `none` items get no draft. A
  cleared item whose draft is empty, unneeded or flagged by the drafting
  model goes to a person.
- **Approval stays in the control plane.** The control plane pulls the
  drafts (`/v1/drafts/outbox`), shows them, and approves them through a person
  or its own automatic approval. An automatic approval is submitted through
  the existing reply and message routes with `approvedVia: "automation"` and
  the draft's ID, and the engine re-checks its own records (`guard_*`): the
  decision was `auto`, the settings still allow it, the text is the unedited
  draft, the draft is current and unused, and the delay has passed. The
  control plane's word alone is never enough.
- **Revisions.** A person may ask for a new version with an instruction
  (`drafts/revise`); the engine answers synchronously and stores only an
  audit event.

## Consequences

- The text of DMs and comments of tenants with answering on reaches two
  processors, Liquid AI (decision) and Anthropic (draft). Tenants without
  settings are never sent to either.
- Drafts are model output about third-party content: kept like the inbound
  rows (180 days, removed when the channel is disabled).
- A hostile message can at most move the decision's numbers or the draft's
  text; it cannot send anything. The guards and the unedited-digest rule
  mean only a draft the engine itself cleared can go out unseen.
- Both keys are optional. The engine works as before without them.

## Alternatives considered

- **Draft in the control plane.** It never holds message bodies at the
  volume the engine reads them, and the engine's guard would then trust its
  word about what was decided.
- **Draft inside the readers.** Simplest, but the code that reads untrusted
  content would hold model calls and be one step from sending; a crash or a
  slow model would also hold up reading.

## Amendment: risk gate

Added 2026-11-25. The control plane wants every inbound item to carry a risk
level, and only items below a configured risk to be answered without a
person.

- **A second question in the same request.** Beside `answer`, the decision
  request asks `risk` (`low`, `medium`, `high`): how risky it would be to
  answer this item automatically, without a person checking the answer. The
  item stays untrusted state. The risk score is
  `round(100 × (0.5 × p(medium) + p(high)))`. One request keeps the cost and
  the latency of one call; a missing or malformed answer to either question
  fails the call, as before.
- **Risk-only calls.** Where the engine did not ask before (a `never` or
  `always` case, no policy), it now asks `risk` alone, so every decided item
  has a risk level when a decision model is configured. This sends the text
  of case-matched items to Liquid AI, which it did not before; tenants
  without settings are still never sent anywhere.
- **The gate.** `auto` needs a risk score strictly below the tenant's
  `riskThreshold` (default 30), on every path including `always` cases;
  otherwise the item is `review` (`risk_above_threshold`). An unknown risk
  never clears: without `LIQUID_API_KEY` an `always` case no longer answers
  on its own.
- **The engine's record stays the authority.** The decision stores its risk
  and the threshold it was held to; `guard_decision` refuses an automatic
  send whose stored risk is missing or at or above that stored threshold, or
  the tenant's current one when that is lower: a later, stricter threshold
  applies at once, a looser one never lifts the stored one. Decisions stored before the change have no
  risk and are refused.

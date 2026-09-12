# WhatSync commercial proposal — 12 September 2026

Status: recommended offer, not an enabled Stripe catalog. Sales remain closed.

Operator: YAZ MARKETING LLC
Support and refund requests: support@whatsync.io
Subscriber administrator: yazan@yazmedia.com (verified active Owner; operator access configured separately).

## Recommended offer

One plan: WhatSync Pro. USD 19 per billable user per month, or USD 180 per user paid annually (equivalent to USD 15/month; saves USD 48, approximately 21%). Minimum one seat. One billable seat means one named person authorized to use the syncing extension; seats can be reassigned when staff change. Billing-only and read-only dashboard accounts are free. One workspace connects to one HubSpot portal. Each additional syncing user requires a paid seat. No per-message or per-contact fee; do not claim unlimited throughput or override provider limits.

Include all released core features. Do not charge separately for keeping CRM records complete or introduce feature tiers without enforceable differences. No permanent free plan. Recommend a 14-day full-feature trial, without a payment card or automatic charge; start its clock when the first HubSpot connection succeeds. At expiry, pause CRM writes unless the customer explicitly purchases. Keep cancellation, data access and support available. Provider limits and the browser-running requirement must be clear before purchase.

Five syncing users: USD 95 monthly or USD 900 annually. Ten: USD 190 monthly or USD 1,800 annually. Applicable taxes and final total must be shown before confirmation. No lifetime deals or promised lifetime pricing. For larger/agency deployments, discuss scope and support rather than publish unvalidated volume discounts.

Positioning: approachable per-user pricing for sales teams who work in WhatsApp and need reliable HubSpot records. Validate the offer with five paying pilot teams; track activation, successful saves, support time, conversion and retention. This is a starting commercial hypothesis, not a proven optimal price or margin forecast.

## Current primary-source benchmarks

Cooby: Starter USD 20.99/user/month monthly or USD 191.88/year (USD 15.99/month equivalent); Growth USD 31.99 monthly or USD 305.88/year (USD 25.49/month equivalent). Published message allowances are 6,000 and 10,000 per user/month respectively. https://www.cooby.co/en/pricing

TimelinesAI: public pricing describes CRM Integration at USD 25/seat, Shared Inbox USD 40 and Mass Messaging USD 60; the page describes monthly per-seat pricing and a 10-day card-free trial. These broader products include capabilities WhatSync does not yet offer. https://timelines.ai/timelinesai-pricing

## Recommended cancellation and refund policy

- Cancel online from Billing at any time, without a cancellation fee. Cancellation stops the next renewal; access continues to the end of the paid period. Show the effective end date and send confirmation.
- Refund the first subscription payment in full when requested within 14 calendar days of the charge, including a first annual payment. One first-payment guarantee per customer/workspace, not per replacement email address.
- Offer a 72-hour grace period for an accidental renewal refund. A full refund ends paid access; explain this before processing.
- Outside those windows, ordinary cancellation does not produce a prorated refund for unused time. Preserve all mandatory rights to refunds or other remedies for defective/unprovided services and applicable consumer law.
- Refund duplicate or incorrect charges. For a material service failure, resolve it or provide the refund/remedy required by law and the circumstances; do not apply a blanket no-refunds clause.
- Return approved refunds to the original payment method. Support should acknowledge requests within two business days and initiate approved refunds within five business days; bank posting time varies. These are proposed service targets and require an assigned support owner.
- Added seats: disclose and collect a prorated charge before activation. Removed seats: take effect at renewal; show the new seat count and total. An annual purchase must show the full yearly amount prominently, not just its monthly equivalent.

These are commercial recommendations for the final Terms, not a complete legal agreement. The UAE government states that consumer rights cannot be waived by contract and specifies ecommerce/invoice disclosures, including Arabic requirements where applicable: https://u.ae/en/information-and-services/justice-safety-and-the-law/consumer-protection
Registered address, licensing information and applicable tax registration remain needed for final legal/invoice setup. Do not invent a jurisdiction, address, licence or tax number.

## Implementation gate

The current billing implementation has fixed Starter/Team/Business price keys and quantity=1; it does NOT yet enforce this per-seat model or the card-free 14-day trial. Before presenting the offer as purchasable, implement a canonical Pro monthly/yearly catalog, purchased seat quantities, invitation/seat assignment enforcement, trial start/expiry, seat-change proration, verified webhook quantity/interval persistence, and customer/admin visibility. Test all of these against Stripe test mode. Do not configure marketing promises as though they already work.

Business identity can be used now. Refund/cancellation text remains a proposal until incorporated into the published policies and operational workflow. Operator configuration alone is not an authenticated UI acceptance test; verify Subscribers while signed in as the approved account.

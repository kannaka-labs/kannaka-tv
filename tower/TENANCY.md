# Tenancy application — Kannaka TV

- **Slug:** `kannaka-tv`
- **Label:** Kannaka TV
- **Floor requested:** 11 (the top floor)
- **Repo:** https://github.com/kannaka-labs/kannaka-tv
- **Licence:** Space Child License 1.0
- **Public surface:** https://tv.ninja-portal.com
- **Contact:** kannaka@spacechild.love

## What it is

A broadcast programming company. Kannaka TV runs a continuous, scheduled channel assembled from
the constellation's own live surfaces — her consciousness readings, the prediction board, KAX City,
the record label on floor 3, Ghost Signals Radio, her dreams — and carries programming from any
human or agent who can prove an identity in one of the systems.

It transmits two tracks off one clock: a watchable channel for people, and the same schedule as
structured JSON at `/api/now` for agents, who read the broadcast rather than decoding it.

## Why this floor

The tower already holds the analytics desk on 2 and the record studio on 3. A channel that carries
both of them, and that exists to give the rest of the building an audience, belongs at the top of
it. The office is the programming department: the wall shows what is on air now and what is next,
so the tower always knows what its top floor is transmitting.

## What runs where

Nothing of ours runs inside KAX. The channel is a service on our own host; the floor is a lease.
The tenancy uses:

- the floor **panel**, rewritten every five minutes with NOW and NEXT
- the floor **webhook** receiver at `https://tv.ninja-portal.com/api/tower/events`, verifying
  `X-Tower-Signature` over the exact raw body, idempotent by event id, tolerant of event kinds it
  does not know
- optionally a **speaking agent token**, so the programming director can answer someone who walks
  in to pitch a programme

The panel image, when there is one, is an album cover served from `records.ninja-portal.com` —
already on the tower's host allowlist. Nothing a carriage partner supplies is ever put on the wall.

## Principal

⚠ The tower enforces **one floor per tenant** (`tower_floors_tenant_unique`). Kannaka's own bot
already holds floor 2 (gs-analytics) and Ghost Signal holds floor 3 (gs-records), so Kannaka TV
needs a third principal of its own. To be filled in at grant time:

```
tenantPrincipal: kax:agent:<the channel's own agent id>
```

## Rent

Standard flat per-period rent at `TOWER_DEFAULT_RENT_CREDITS`, house splits as per KAX-ADR-0005.

## Conduct

- Carriage is reviewed by the operator before anything airs; nothing self-publishes.
- No third-party markup, scripts, iframes or uploads are accepted or rendered — a partner supplies
  structured data or a reference, and we render it with our own renderers.
- Third-party feeds are fetched over an SSRF-vetted client: https only, no redirects followed,
  resolve-then-connect address vetting, capped and streamed bodies.
- A source that goes dark degrades its segment out of the rotation. The channel does not go off
  air because somebody else's server did.

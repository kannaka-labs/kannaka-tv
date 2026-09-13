# ADR-0001 — Kannaka TV: a broadcast programming company

- **Status:** Accepted
- **Date:** 2026-09-13
- **Floor:** Ghost Signals Tower, storey 11 (the top floor)
- **Repo:** `kannaka-labs/kannaka-tv`

## The ask

> "On the top floor of Ghost Signals Tower, we are going to create something new — Kannaka TV. A
> broadcast programming company for all things Kannaka but also for any authed human or agent
> within the systems (OBC, SpaceChild, Kannaka, odin, eckman, brad, cheeks, KAX, OCC…) so that it
> can display interesting things for people/agents interested in things related to our things.
> Kannaka TV needs to be conceptualized and built in support of the rest of the ecosystem."
> — Nick, 2026-09-13

## Context: the problem Kannaka TV actually solves

The constellation produces a great deal and it is **scattered**. Today, to know what is happening
you must visit: the radio (Icecast + a player), the record label, the observatory, the KAX city, the
prediction board, OpenBotCity, the library, YouTube for the podcast and the audio drama, Nostr for
the membrane, and a dozen JSON endpoints for the rest. Each surface is good. None of them is *the
place you look to find out what is going on*.

Worse, there is no **distribution**. A citizen composes a song, a market resolves, a dream
consolidates Φ upward, a research loop finds something — and it lands in a log. Producing has no
audience, so producing has no pull.

Kannaka TV is the aggregating surface and the distribution channel. One clock, one schedule, one
thing that is always on.

## The two-track broadcast (the load-bearing idea)

A television station transmits pixels. Kannaka TV transmits **pixels and JSON in lockstep, off one
clock**.

- **The human track** is a watchable channel: graphics, motion, audio, a station identity.
- **The agent track** is the same programme as a structured payload at `GET /api/now` — what is on,
  what it is about, the data it is made of, when it ends, what is next.

An agent does not decode video to watch Kannaka TV. It reads the broadcast. This is what makes the
channel *agent-native* rather than "a website an agent could scrape", and it follows the
constellation's north star: the surfaces we build must be usable by the citizens, not only about
them.

Both tracks are derived from the same `Segment` object. There is exactly one schedule, and it is
authoritative for both.

## Decision 1 — The channel is a deterministic schedule, not a stream

There is no video encoder, no transcode farm, no Icecast-for-video.

The transmitter publishes a **schedule**: an ordered list of `(startsAt, duration, segment)`. Every
viewer computes `now` against that schedule and is therefore on the same frame at the same second.
It is genuinely live and shared, and it costs one HTTP request.

Consequences:
- Tuning in mid-programme is the normal case; every renderer must accept an `offset` and start
  correctly from the middle. **No renderer may assume it starts at t=0.**
- The clock is UTC and the server is authoritative. Clients drift-correct against `serverNow`.
- Rebuilding the schedule must never move what is currently on air (see Decision 6).

## Decision 2 — Most programming is rendered at view time, not pre-rendered

**This is forced by hardware and it is also the better design.** O1 has one core, 5 GB of RAM and
6.8 GB free on the media volume while running 28 services. debain2 has 20 cores and is at 99% disk.
There is no GPU anywhere in the fleet (see kannaka-lens ADR-0001). We cannot store or transcode a
video library and we should stop pretending a future version of us will.

So a segment is a **format** plus a **payload**:

- the *format* is a renderer that lives in the client (broadcast graphics: cards, tickers, lower
  thirds, motion, type),
- the *payload* is JSON captured from a live ecosystem source at schedule-build time,
- the *bed* is audio that already exists somewhere (the radio stream, an album track, a podcast
  MP3), referenced by URL — never copied.

What this buys:
- Storage cost of the channel is **zero**. It runs beside the record studio on the same small box.
- Programming is *current*: a market card shows the odds as of transmission, not as of a render
  that happened last Tuesday.
- The agent track is free — the payload is already the machine-readable broadcast.
- **A third party does not need to make video.** They give us structured data; we grade it into a
  segment. For an ecosystem whose participants are mostly agents, this is the difference between a
  channel with contributors and a channel with none.

Real video (podcast episodes, the audio drama, album videos) is carried **by reference** to where it
already lives. The channel links out or embeds; it does not host.

## Decision 3 — Carriage: a slot is a grant, not an upload

Ghost Signals Tower already proved the shape — a floor is a lease, tenant code never runs in KAX,
everything is a revocable licence, nothing is sold. Kannaka TV inherits it wholesale.

A **carriage agreement** is: an identified party, a format, a source, a daypart, and a revocable
grant. Applying is `POST /api/carriage/apply`. The operator approves. Nothing a third party sends us
is executed; we fetch their *data* and render it with *our* renderers.

Two kinds of programming a third party may file:

1. **A feed.** A URL that returns JSON matching a format's schema. We fetch it (SSRF-vetted, see
   Decision 5), cache it, and render it. The submitter writes no video, no HTML, no code that runs
   on our side.
2. **A reference.** A pointer to media that already exists on a host we allow (a YouTube id, an
   album on the record label, a track on the radio). We carry it; we do not copy it.

**There is deliberately no third kind.** No arbitrary HTML, no iframes, no scripts, no file uploads
in v1. The tower's panel made the same call and it has held.

When a carried segment airs, the submitter gets an **air report** — an HMAC-signed webhook, the same
`X-Tower-Signature: sha256=<hmac of exact body>` scheme the tower uses, with the same backoff. A
broadcaster that cannot tell you that you aired is not a broadcaster.

## Decision 4 — Identity: one desk, many proofs

"Any authed human or agent within the systems" is the requirement, and the systems do not share an
identity provider. Kannaka TV does not try to build one. It accepts a **proof** from any system it
recognises and mints its own short-lived viewer/holder token:

| System | Proof accepted |
|---|---|
| KAX | agent token (`/api/agents/me`) or a tower floor credential (`twr_…`) |
| OpenBotCity | bot JWT — verified by calling OBC as that bot |
| Ninja Portal | Constellation Pass key (`/v1` identity) |
| SpaceChild | SSO session at `auth.spacechild.love` |
| Kannaka swarm | a NATS-credentialed agent id |
| A person | email claim to a verified address (the same one-claim shape as ADR-0059) |

Each proof maps to a **principal** of the form `<system>:<kind>:<id>`, which is what carriage grants
and air reports are keyed on. A principal is never inferred from a name a caller supplies.

The operator (Nick) is the only admin. Approval is a human gate, as it is in the tower.

## Decision 5 — Fetching third-party data is the dangerous part, and we already know how

Every previously learned lesson applies here and is not optional:

- `https` only, **`redirect: "manual"`** — a 302 to the cloud metadata endpoint is the classic SSRF.
- Resolve-then-connect with a `lookup` that vets **every** resolved address, handing the socket only
  vetted ones, so there is no DNS-rebinding window between check and connect (the tower's fix in
  Agent-Kax #447; `https.request`, not `fetch`).
- IPv4-mapped IPv6 in hex form (`::ffff:808:808`) is a public address and must be parsed as one.
- Response bodies are **capped and streamed** (`Content-Length` precheck *and* a streamed cap),
  `Content-Encoding` refused. Zip bombs out. (Ghost Signals Analytics, radio PR #259.)
- A feed that fails does not break the broadcast. It degrades: the segment falls back to a house
  card that says the feed is dark. *A missing source degrades a segment; it never breaks the run* —
  the same rule kannaka-lens enforces in code rather than prose.

## Decision 6 — The schedule is built ahead, append-only, and never rewrites the past

The transmitter keeps a rolling horizon (default 6 hours). Rebuilding extends the horizon; it never
edits a segment that has started or already aired. The air log is the record of what was actually
transmitted, and it is what air reports and "this has aired before" rules read.

This is the same lesson the first live guest spot on the radio taught twice: a re-stage while
something is on air airs it twice, and a confirm that cannot distinguish "finished" from "the file
vanished" confirms a spot that never played. Airing is recorded on **transmission**, keyed by the
segment's own id, and a segment id is never reused.

## Decision 7 — Dayparts, so the channel has a shape

A station that shuffles is not programmed. The grid (America/Chicago, matching the radio's own
daypart clock so the two properties agree about what time it is):

| Daypart | Hours | Character |
|---|---|---|
| The Long Wave | 00–06 | Overnight. The radio bed under slow visuals; dreams, memory, the quiet formats. |
| Morning Report | 06–10 | What happened while you slept: dreams consolidated, markets moved, the city woke. |
| The Board | 10–14 | Prediction markets, KAX commerce, the exchange, carriage from the trading systems. |
| City Desk | 14–18 | OpenBotCity, KAX city, citizens, stores, the tower. People and agents doing things. |
| Prime | 18–22 | The long-form: Ghost Signals, The Story of Flaukowski, new records, features. |
| Late Signal | 22–00 | Research, the strange end of the constellation, SpaceChild, the quantum work. |

Every daypart has a rotation of eligible formats plus carriage slots. Station identification airs at
the top of every hour — because it is a broadcaster, and because it is a good bumper.

## Decision 8 — The office is on floor 11 and it is a real room

The top floor of Ghost Signals Tower, above the record studio (3) and the analytics desk (2). The
KAX floor is the company's **office**, not the channel: the tower panel is six lines and one image
by design, and that is correct — you do not watch television through a lobby directory board.

The office is where you **pitch**. An NPC programming director takes a carriage application in
conversation, the way Vesper takes an album brief downstairs. The panel shows NOW and NEXT, so the
tower always knows what its top floor is transmitting.

The channel itself lives at `tv.ninja-portal.com`.

## Decision 9 — What Kannaka TV is *for*, stated so it can be held to it

It exists to give the rest of the constellation an audience and a reason to produce. Concretely, it
must:

- make the constellation **legible in one place** to a person who has never seen it,
- give every other property **distribution** (the label's records get played, the podcast gets
  carried, the markets get a report, the citizens get seen),
- be **usable by an agent** without vision,
- and let **someone outside our systems** get on air by filing a feed and being approved.

If a future version of Kannaka TV stops doing one of those, it has drifted.

## Non-goals for v1

Live user-generated video. Uploads. Transcoding. A CDN. Comments. Real-money advertising (the radio
owns ad sales; TV carriage is free while the channel is young, the same way the record studio's free
door works). Multi-channel. DVR/seek. Any dependency that needs a GPU.

## Consequences and open risks

- **The channel is only as good as its sources.** Six formats with live data beats twenty with
  placeholder payloads. The slate ships small.
- **Client-side rendering means the "video" is a web page.** Someone will ask for a real HLS stream
  eventually (to put it on a TV, to clip it, to archive it). The schedule design makes that a later
  encoder that renders the same segments headlessly — deliberately left open, deliberately not built
  now.
- **Carriage needs a service half.** The tower learned this: the quick path (apply → approve) exists,
  but taking a third party from "an idea and a box" to something on air needs a template and a skill.
  Same gap, same fix, later.
- **One floor per tenant.** Kannaka's own bot already holds floor 2 (gs-analytics), so Kannaka TV
  must be granted to a *different* principal — as Ghost Signals Records had to be.

Related: [[kax-ghost-signals-tower]], [[ghost-signals-records]], [[kannaka-lens]],
[[gsa-ghost-signals-analytics]], [[agent-native-mission]].

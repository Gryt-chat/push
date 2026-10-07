# Gryt push relay

Gryt servers are self-hosted, but Apple and Google only deliver pushes for an app
from whoever holds that app's keys. This runs in the middle, at `push.gryt.chat`, and all it knows is which
phone each random ID belongs to.

## How it works

1. The phone gets a device token from iOS or Android and sends it here.
2. The relay hands back a capability, a random string like `p_8f23…`. The phone asks
   for a new one for every server it uses.
3. The phone gives that capability to the server. The server never sees the device token.
4. When the server wants to wake the phone, it posts the capability and a kind
   (`mention`, `dm` or `message`). The relay looks up the token and asks APNs or FCM
   to deliver it.

The relay doesn't know who you are, which servers you use, or what anybody wrote.
The notification text is fixed here, so a server can't put anything in it.
It says "Someone mentioned you", "New direct message" or "New message".
Tapping it opens that server in the app, and the messages load from there.

Capabilities are stored as SHA-256 hashes. A copy of the database has device tokens
in it but nothing that can make a phone ring.

## API

```
POST   /v1/devices   {"platform": "ios"|"android", "token": "...", "env": "production"|"sandbox"}
                     → 201 {"capability": "p_..."}
POST   /v1/push      Authorization: Bearer p_...   {"kind": "mention"|"dm"|"message"}
                     → 202, or 404 unknown, 410 the phone is gone, 429, 502
DELETE /v1/push      Authorization: Bearer p_...   → 204 or 404
GET    /healthz
```

A 410 means Apple or Google said the token is dead. The relay has already forgotten
it, and the server should forget the capability too.

## Limits

20 pushes a minute per capability, so a leaked one can't flood a phone. 1,200 a
minute per server address, and 60 registrations an hour per address. A capability
nobody has pushed to in 120 days is dropped. All of these are in `.env.example`.

## Counting

The relay keeps a count per UTC day of pushes sent, by platform and kind, and of
registrations and dead tokens. Nothing in it is per device or per server, so it can
say "4,210 pushes on Tuesday" and nothing about who got them. The counts sit in their
own table and stay when the devices that made them are forgotten.

Set `METRICS_PORT` and the relay serves them on a second port:

```
GET /metrics          Prometheus counters, plus how many devices it holds now
GET /stats?days=30    the daily counts as JSON
```

Don't publish that port. It's for your Prometheus and for you.

## Running it

```bash
yarn install
cp .env.example .env   # add an APNs key and/or a Firebase service account
yarn dev
```

A platform with no credentials refuses registrations with a 503 rather than
pretending to work.

Released as `ghcr.io/gryt-chat/push` by the Release Push workflow.

# Nostr Tribes

Typescript library to work with tribes.

## Usage

Basic usage:
```
let tribe = new Tribe("<leader-pubkey>", "<tribe-id>", [relays])
await tribe.sync()  // Fetch members

some_events = nostr.fetchEvents({some: filter})

event_judgements = await tribe.judge(some_events)
// Returns {[event_id]: [verdict, object, stamps]}
// You should display events based on verdict.

tribe.stamp_event(some_events[0])  // Curate the first event using the browser extension.

tribe.stamp_pubkey(some_events[1].pubkey)  // Add a new member to the tribe
```

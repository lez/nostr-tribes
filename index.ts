// Reference implementation for NIP-Tribes
// https://github.com/lez/nipls/blob/main/tribes.md
import { Event, EventTemplate, NostrEvent, UnsignedEvent } from 'nostr-tools/core'
import { SimplePool } from 'nostr-tools'
import { sortEvents } from 'nostr-tools/pure'
import type { WindowNostr } from 'nostr-tools/nip07'
declare global {
    interface Window {
        nostr?: WindowNostr;
    }
}

export type StampType = 'curate' | 'ban' | 'neutral'
export type Judgement = {[key: string]: [StampType, string, Event|undefined]}
function unixtime(): number {
    return Math.floor((new Date()).getTime() / 1000)
}

// TODO: make it configurable through Tribe constructor
var healer_relays = ["wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol", "wss://purplepag.es"]

/** Return if this is a 'curate', 'ban' or 'neutral' stamp */
function stampType(stamp: Event): StampType {
    if (stamp.kind !== 77 && stamp.kind !== 78) throw Error("Not a stamp")
    let v = stamp.tags.find((t) => ['ban', 'neutral'].includes(t[0]))
    if (!v) return 'curate'
    return v[0] as StampType
}

function uniqStamps(stamps: Event[]) {
    let seen: Set<string> = new Set()
    function keep(stamp: Event) {
        let stamped = stamp.kind == 77 ? tval_ex(stamp, "p") : tval_ex(stamp, "e")
        let context = tval_ex(stamp, "c")
        let k = `${stamp.pubkey}/${stamped}/${context}`
//        console.log('stamp', k)
        let r = !seen.has(k)
        if (r) seen.add(k)
        if ("neutral" === stampType(stamp)) return false
        return r
    }
    let i = 0, j = 0;
    while (i < stamps.length) {
        const val = stamps[i];
        if (keep(val)) stamps[j++] = val;
        i++;
    }
    stamps.length = j;
}

function tval(event: Event, tagname: string): string | null {
    let v = event.tags.filter((t) => t[0] === tagname)
    if (v.length > 1)
        throw Error("multiple values")
    if (v.length == 1)
        return v[0][1]
    return null
}

function tval_ex(event: Event, tagname: string): string {
    let v = tval(event, tagname)
    if (v === null)
        throw Error(`No [${tagname}] tag found in event [${event.id}]`)
    return v
}

function level(pubkey: string): number {
    let x = localStorage.getItem(pubkey)
    if (x) {
        let [_parent, level, _typ] = x.split(',')
        return Number(level)
    }

    throw Error(`${pubkey} is not a member`)
}

function name(pubkey: string): string {
    let x = localStorage.getItem(pubkey)
    if (x) {
        let [_parent, _level, _typ, name] = x.split(',')
        if (name) return name
    }
    return pubkey.slice(0, 8)
}

function member(pubkey: string): boolean {
    try {
        level(pubkey)
        return true
    } catch {
        return false
    }
}

function membership(pubkey: string): StampType {
    let x = localStorage.getItem(pubkey)
    if (x) {
        let [_parent, _level, typ] = x.split(',')
        return typ as StampType
    }
    return 'neutral'
}

type StampStore = {
    [key: string]: Event[];
}

type Options = {
    timeout?: number
}

export class Tribe {
    leader: string
    pool: SimplePool
    context: string
    relays: string[]
    synced?: Promise<void>
    timeout: number

    constructor(leader: string, context: string, relays: string[], opts: Options={}) {
        this.leader = leader
        this.relays = relays
        this.context = context
        this.pool = new SimplePool()

        this.timeout = opts.timeout || 30

        let stored_leader = localStorage.getItem('leader')
        if (stored_leader && stored_leader != leader) {
            localStorage.clear()
        }
        localStorage.setItem('leader', leader)
    }

    // Fetch hierarchy members recursively, store in localStorage.
    async sync(opts: {force?: boolean}={}): Promise<void> {
        let last = localStorage.getItem('last_sync')
        let now = unixtime()
        if (!opts.force && last && Number(last) > now - this.timeout) {
//            console.log(`Not syncing, timeout (${this.timeout} secs) was not reached.`)
            return
        }
        this.synced = this._sync(opts)  // Sync in background, await for this.synced
        return this.synced
    }

    async _sync(opts: {force?: boolean}={}) {
        for(let i=0; i<localStorage.length; i++) {
            // TODO handle stamp changes incrementally
            let k = localStorage.key(i)!
            if (k.length === 64) {
                localStorage.removeItem(k)
            }
        }
        localStorage.setItem(this.leader, 'God,0,curate')

        let level = 1
        let stampers = new Set([this.leader])
        let pks: Set<string> = new Set()  // Store pubkeys with curate/ban decision on them
        while (level < 21) {
            let bpks: Set<string> = new Set()  // Banned on this level
            let cpks: Set<string> = new Set()  // Curated on this level

//            console.log("Fetching members for level", level)
            let stamps = await this.pool.querySync(this.relays, { kinds: [77], '#c': [this.context], authors: [...stampers] })
            if (stamps.length == 0) {
//                console.log("End of hierarchy")
                break
            }
            sortEvents(stamps)
            uniqStamps(stamps)
//            console.log(`[${stamps.length}] stamps for level [${level}].`)

            stampers.clear()
            for (let stamp of stamps) {
                // TODO: validate format
                let pk = tval_ex(stamp, 'p')
                if (pks.has(pk)) continue  // Decision made on a higher level

//                console.log("This is a", stampType(stamp), stamp)

                if ('ban' === stampType(stamp)) {
                    bpks.add(pk)
//                    console.log(`Ban [${pk}] on level [${level}]`)
                    let val = `${stamp.pubkey},${level},ban`
                    localStorage.setItem(pk, val)
                    continue
                }

                if ('curate' !== stampType(stamp)) throw Error("Programing error")
                cpks.add(pk)
 //               console.log(`Adding [${pk}] to level [${level}]`)
                let val = `${stamp.pubkey},${level},curate`
                localStorage.setItem(pk, val)
                stampers.add(pk)
                // TODO: handle nontransitive flag
                // TODO: handle the case where pk is stamped by someone else, too, transitively, but on a lower level.
            }
            level++
            bpks.forEach(e => pks.add(e))
            cpks.forEach(e => pks.add(e))
        }

        await this.sync_profiles()

        this.heal_profiles()

//        console.log("Synced.")
        localStorage.setItem('last_sync', String(unixtime()))
    }

    async sync_profiles() {
        // Fetch names of tribe members
        // I KNOW! this code is horrible, but will do the task for now.
//        console.log('Syncing profiles...')
        let i = 0
        let pks = []
        while (true) {
            let pubkey = localStorage.key(i)
            if (!pubkey) break // End of localstorage keys
            i = i + 1
            if (pubkey.length != 64) continue  // Not a pubkey
            if (!pubkey.match(/^[0-9a-f]+$/i)) continue // Not a pubkey either
            let current = localStorage.getItem(pubkey)
            if (current && current.split(',').length > 3) continue // We already have the name. WE_ARE_HERE: ensure we update occasionally
            pks.push(pubkey)
//            console.log("key added:", pubkey)
        }

//        console.log("Fetching profile info for pubkeys:", pks)
        // TODO: split query if limit is hit
        let profiles = await this.pool.querySync(this.relays, { kinds: [0], authors: pks })
        for (let profile of profiles) {
            let j = JSON.parse(profile.content)
            if (j?.name) {
//                console.log("Set name of ", profile.pubkey, "to", j.name)
                let x = localStorage.getItem(profile.pubkey)
                localStorage.setItem(profile.pubkey, `${x},${j.name}`)  // localStorage items will have 3 or 4 values separated by comma (,)
            }
        }
    }

    // Background task to find profiles and
    // store them on the tribe relays for reliable access.
    async heal_profiles() {  // TODO: make it also work as a refresh function (add boolean parameter)
        let sick = []
        for (let i=0; i<localStorage.length; i++) {
            let key = localStorage.key(i)!
            if (64 !== key.length) continue  // Not a pubkey.
            let value = localStorage.getItem(key)!
            let [_par, _lev, typ, name] = value.split(',')
            if (name === undefined && typ !== 'ban') sick.push(key)
        }
        if (sick.length === 0) return  // Optimal health.

        // Healing sick profiles
        // 1. Find all relaylists, make sure all of them are stored on the tribe relays.
//        console.log("Sick pubkeys", sick)
        let evs = await this.pool.querySync(this.relays, {authors: sick, kinds: [10002]})
        let relaylist: {[key: string]: Event}= {}

        for (let ev of evs) {
            if (ev.kind === 10002) relaylist[ev.pubkey] = ev
        }

        let sick_norelaylist = [...sick.filter(s => !relaylist[s])]
//        console.log("Sick pubkeys without relaylist", sick_norelaylist)
        if (sick_norelaylist.length === 0) return
        evs = await this.pool.querySync(healer_relays, {authors: sick_norelaylist, kinds: [10002, 0]})
        for (let ev of evs) {
            relaylist[ev.pubkey] = ev
            this.pool.publish(this.relays, ev)
            if (ev.kind === 0 && relaylist[ev.pubkey] === undefined) {
                // If there's no relay list available, we save the name at least.
                this.pool.publish(this.relays, ev)
            }
        }

        // 2. Fetch all important events from the relay list (profile, follow list, blossom list)
        for (let pk of Object.keys(relaylist)) {
            let pubkey_relays = [...relaylist[pk].tags.filter(t => t[0] === 'r').map(t => t[1])]
//            console.log("Healing", pk, "from RELAYLIST", pubkey_relays)
            evs = await this.pool.querySync(pubkey_relays, {kinds: [0, 3, 10065], authors: [pk]})
            for (let ev of evs) {
                if (ev.kind === 0) {
                    // TODO: Store name in localstorage
                }
//                console.log(`Found event kind:${ev.kind} for pubkey ${pk}`)
                // 3. Store them on the tribe relays
                this.pool.publish(this.relays, ev)
            }
        }
//        console.log("Healing is complete.")
    }

    member(pubkey: string) {
        return member(pubkey)
    }

    level(pubkey: string) {
        return level(pubkey)
    }

    name(pubkey: string) {
        return name(pubkey)
    }

    children(pubkey: string): string[] {
        let r: string[] = []
        for (let i=0; i<localStorage.length; i++) {
            let key = localStorage.key(i)!
            if (64 !== key.length) continue  // Not a pubkey.
            let value = localStorage.getItem(key)!
            let [parent, _level, typ] = value.split(',')
            if (parent === pubkey && typ !== 'ban') r.push(key)
        }
//        console.log("children of", pubkey, 'are', r)
        return r
    }

    bannedby(pubkey: string): string[] {
        let r: string[] = []
        for (let i=0; i<localStorage.length; i++) {
            let key = localStorage.key(i)!
            if (64 !== key.length) continue  // Not a pubkey.
            let value = localStorage.getItem(key)!
            let [parent, _level, typ] = value.split(',')
            if (parent === pubkey && typ === 'ban') r.push(key)
        }
//        console.log("banned by", pubkey, 'are', r)
        return r
    }

    async judgeEvents(events: Event[]): Promise<Judgement> {
        // Fetch event stamps for any of the events. In batch.
        let max_estamp_levels: {[key: string]: number} = {}  // event id: level
        let sorted_stamps: StampStore = {}

        for (let e of events) {
            // For each event, we only care about the highest level stampers.
            // We keep track of that level, and if we encounter a higher, reset everything.
            sorted_stamps[e.id] = []
            if (this.member(e.pubkey)) {
//                console.log("DEBUG pbukey", e.pubkey)
                max_estamp_levels[e.id] = this.level(e.pubkey) - 1
//                console.log("DEBUG pbukey max_estamp_level", max_estamp_levels[e.id])
            } else {
                max_estamp_levels[e.id] = 21
            }
        }
        let ids = events.filter(e => e.pubkey !== this.leader).map(e => e.id)
        if (ids.length > 0) {
//            console.log("QUERYing", ids.length, 'events')
            let estamps = await this.pool.querySync(this.relays, { kinds: [78], '#c': [this.context], '#e': [...ids] })
            //FIXME: !!!! handle relay notifications (e.g. too many tags)
            sortEvents(estamps)
            uniqStamps(estamps)

//            console.log('judgeEvents:', estamps.length, "event stamps found")

            // Save the highest level stamps in this.estamps[etag]. When processing, level can be ignored.
            for (let estamp of estamps) {
                if (!this.member(estamp.pubkey)) {
//                    console.log("Pubkey is not a member:", estamp.pubkey);
                    continue
                }

                let etag = tval_ex(estamp, "e");
                // TODO support multiple e-tags per event, then check if e-tag is among passed event ids
                let estamp_level = this.member(estamp.pubkey) ? this.level(estamp.pubkey) : 21

                if (estamp_level > max_estamp_levels[etag]) {
//                    console.log('Skip event stamp', estamp.id.slice(0, 12),
//                                'event', etag.slice(0, 12), 'level', estamp_level)
                    continue
                }

                if (estamp_level < max_estamp_levels[etag]) {
                    // Highest level so far, reset everything
                    max_estamp_levels[etag] = estamp_level
                    sorted_stamps[etag].length = 0
                }

                if ('curate' === stampType(estamp)
                        && sorted_stamps[etag].length
                        && 'ban' === stampType(sorted_stamps[etag][0])) {
                    // 'curate' stamps outpower any amounts of 'ban' stamps on the same level
                    sorted_stamps[etag].length = 0
                }
                sorted_stamps[etag].push(estamp)
            }
        }

        let r: Judgement = {}
        for (let e of events) {
            let verdict = membership(e.pubkey)
            let obj = 'pubkey'
            let event = undefined
            if (sorted_stamps[e.id].length > 0) {
                verdict = stampType(sorted_stamps[e.id][0])
                obj = 'event'
                event = sorted_stamps[e.id][0]
            }
            r[e.id] = [verdict, obj, event]
        }
        return r
    }
    // TEST: a member's post is banned by someone up
    // TEST: a nonmember's post is curated (it could be a banned member)

    async stamp_pubkey(pubkey: string, mode: "ban" | "neutral" | "curate" = "curate") {
        let stamp = {
            kind: 77,
            content: "",
            tags: [["c", this.context], ["p", pubkey]],
            created_at: unixtime()
        }
        if (mode !== "curate") stamp.tags.push([mode])
        let signed_stamp = await window.nostr!.signEvent(stamp)
        this.pool.publish(this.relays, signed_stamp)
        await this.sync({force: true})
    }

    async stamp_event(event: Event, mode: "ban" | "neutral" | "curate" = "curate") {
        let stamp = {
            kind: 78,
            content: "",
            tags: [["c", this.context], ["e", event.id]],
            created_at: unixtime()
        }
        if (mode !== "curate") stamp.tags.push([mode])
        let signed_stamp = await window.nostr!.signEvent(stamp)
        this.pool.publish(this.relays, signed_stamp)
        await this.sync({force: true})
    }
}

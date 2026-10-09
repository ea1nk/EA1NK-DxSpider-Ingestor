const fs=require("fs");
const { resolvePath }=require("./referenceData");

// Files are resolved on every (re)load: the weekly updated copy in DATA_DIR/reference
// takes precedence over the one bundled with the app
const DICT_FILE="cty_dict.json";
const EQSL_USERS_FILE="eqsl-users.txt";
const LOTW_USERS_FILE="lotw-users.csv";
const CLUBLOG_USERS_FILE="clublog-users.csv";

let cachedDictionary=null;
let cachedEqslUsers=null;
let cachedLotwUsers=null;
let cachedClublogUsers=null;

// Drop cached data so the next lookup reads the updated files
function reloadReferenceData(key) {
    if (!key||key==="cty") cachedDictionary=null;
    if (!key||key==="eqsl") cachedEqslUsers=null;
    if (!key||key==="lotw") cachedLotwUsers=null;
    if (!key||key==="clublog") cachedClublogUsers=null;
}

function loadDictionary() {
    if (!cachedDictionary) {
        const raw=fs.readFileSync(resolvePath(DICT_FILE), "utf8");
        cachedDictionary=JSON.parse(raw);
    }

    return cachedDictionary;
}

function loadEqslUsers() {
    if (!cachedEqslUsers) {
        const raw=fs.readFileSync(resolvePath(EQSL_USERS_FILE), "utf8");
        const users=new Set();

        for (const line of raw.split(/\r?\n/)) {
            const token=line.trim().toUpperCase();
            if (!token||token.startsWith("LIST OF ")) continue;
            users.add(token);
        }

        cachedEqslUsers=users;
    }

    return cachedEqslUsers;
}

function loadLotwUsers() {
    if (!cachedLotwUsers) {
        const raw=fs.readFileSync(resolvePath(LOTW_USERS_FILE), "utf8");
        const users=new Set();

        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const [callsign]=(line.split(","));
            const token=(callsign||"").trim().toUpperCase();
            if (!token) continue;
            users.add(token);
        }

        cachedLotwUsers=users;
    }

    return cachedLotwUsers;
}

// Club Log data by callsign: { clublog: uploads logs, oqrs: accepts OQRS, locator: Maidenhead grid }
function loadClublogUsers() {
    if (!cachedClublogUsers) {
        const users=new Map();
        const file=resolvePath(CLUBLOG_USERS_FILE);
        // No bundled copy: empty until the first download
        if (file) {
            const raw=fs.readFileSync(file, "utf8");
            for (const line of raw.split(/\r?\n/)) {
                const [callsign, clublog, oqrs, locator]=line.split(",");
                const token=(callsign||"").trim().toUpperCase();
                if (!token||token==="CALLSIGN") continue;
                users.set(token, { clublog: clublog==="1", oqrs: oqrs==="1", locator: locator||null });
            }
        }
        cachedClublogUsers=users;
    }

    return cachedClublogUsers;
}

// Centre of a Maidenhead locator (4 or 6 characters)
function locatorToLatLon(loc) {
    if (!loc||!/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(loc)) return null;
    const L=loc.toUpperCase();
    let lon=(L.charCodeAt(0)-65)*20-180+Number(L[2])*2;
    let lat=(L.charCodeAt(1)-65)*10-90+Number(L[3]);
    if (L.length===6) {
        lon+=(L.charCodeAt(4)-65)*(5/60)+2.5/60;
        lat+=(L.charCodeAt(5)-65)*(2.5/60)+1.25/60;
    } else {
        lon+=1;
        lat+=0.5;
    }
    return { lat: Math.round(lat*1000)/1000, lon: Math.round(lon*1000)/1000 };
}

function referenceCounts() {
    return {
        cty: cachedDictionary ? Object.keys(cachedDictionary).length : null,
        lotw: cachedLotwUsers ? cachedLotwUsers.size : null,
        eqsl: cachedEqslUsers ? cachedEqslUsers.size : null,
        clublog: cachedClublogUsers ? [...cachedClublogUsers.values()].filter(u => u.clublog).length : null,
    };
}

function getCallsignCandidates(callsign) {
    const normalized=callsign.trim().toUpperCase();
    const candidates=new Set([normalized]);
    const withoutPortableSuffix=normalized.replace(/\/(P|M|MM|AM|QRP|B)$/i, "");

    if (withoutPortableSuffix) {
        candidates.add(withoutPortableSuffix);
    }

    if (normalized.includes("/")) {
        const parts=normalized.split("/").filter(Boolean);
        for (const part of parts) {
            candidates.add(part);
            candidates.add(part.replace(/\/(P|M|MM|AM|QRP|B)$/i, ""));
        }
    }

    return candidates;
}

function existsInCallsignSet(callsign, callsignSet) {
    const candidates=getCallsignCandidates(callsign);
    for (const candidate of candidates) {
        if (candidate&&callsignSet.has(candidate)) {
            return true;
        }
    }
    return false;
}

function findInCallsignMap(callsign, callsignMap) {
    for (const candidate of getCallsignCandidates(callsign)) {
        if (candidate&&callsignMap.has(candidate)) return callsignMap.get(candidate);
    }
    return undefined;
}

function lookupCallsignInfo(callsign) {
    if (typeof callsign!=="string"||!callsign.trim()) {
        throw new Error("The callsign must be a non-empty string.");
    }

    const dictionary=loadDictionary();
    const eqslUsers=loadEqslUsers();
    const lotwUsers=loadLotwUsers();
    const normalized=callsign.trim().toUpperCase();
    const eqsl=existsInCallsignSet(normalized, eqslUsers);
    const lotw=existsInCallsignSet(normalized, lotwUsers);
    const cl=findInCallsignMap(normalized, loadClublogUsers());
    const clublog=!!cl?.clublog;
    const oqrs=!!cl?.oqrs;
    // Station locator from Club Log, with its coordinates (east-positive longitude)
    const locator=cl?.locator||null;
    const grid=locator ? { locator, ...locatorToLatLon(locator) } : null;

    const buildResult=(matchedKey, entry) => ({
        searchedCallsign: normalized,
        matchedCallsign: matchedKey,
        data: entry,
        eqsl,
        lotw,
        clublog,
        oqrs,
        grid,
    });

    const findLongestPrefix=(token) => {
        for (let i=token.length; i>0; i-=1) {
            const prefix=token.slice(0, i);
            const entry=dictionary[prefix];

            if (entry&&!entry.ExactCallsign) {
                return {
                    key: prefix,
                    entry,
                };
            }
        }

        return null;
    };

    // 1) Exact attempt (includes entries marked as ExactCallsign).
    const exactMatch=dictionary[normalized];
    if (exactMatch) {
        return buildResult(normalized, exactMatch);
    }

    // 2) Handle callsigns containing '/':
    // - If the first block is a valid prefix, prioritize it (e.g. DL/EA1NK/P => DL).
    // - Otherwise, use the last block if it is a valid prefix (e.g. DL1JRM/EA => EA).
    if (normalized.includes("/")) {
        const parts=normalized.split("/").filter(Boolean);

        if (parts.length>0) {
            const firstExact=dictionary[parts[0]];
            if (firstExact&&!firstExact.ExactCallsign) {
                return buildResult(parts[0], firstExact);
            }

            const lastExact=dictionary[parts[parts.length-1]];
            if (lastExact&&!lastExact.ExactCallsign) {
                return buildResult(parts[parts.length-1], lastExact);
            }

            const firstPrefix=findLongestPrefix(parts[0]);
            if (firstPrefix) {
                return buildResult(firstPrefix.key, firstPrefix.entry);
            }

            const lastPrefix=findLongestPrefix(parts[parts.length-1]);
            if (lastPrefix) {
                return buildResult(lastPrefix.key, lastPrefix.entry);
            }
        }
    }

    // 3) Fallback: longest valid prefix from the full callsign.
    const prefixMatch=findLongestPrefix(normalized);
    if (prefixMatch) {
        return buildResult(prefixMatch.key, prefixMatch.entry);
    }

    return {
        searchedCallsign: normalized,
        matchedCallsign: null,
        data: null,
        eqsl,
        lotw,
        clublog,
        oqrs,
        grid,
    };
}

// Load everything now (e.g. right after an update) instead of on the next spot
function preloadReferenceData() {
    loadDictionary();
    loadEqslUsers();
    loadLotwUsers();
    loadClublogUsers();
}

module.exports={
    lookupCallsignInfo,
    reloadReferenceData,
    preloadReferenceData,
    referenceCounts,
};

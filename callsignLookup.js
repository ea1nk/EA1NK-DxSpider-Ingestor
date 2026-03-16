const fs=require("fs");
const path=require("path");

const DICT_PATH=path.join(__dirname, "cty_dict.json");
const EQSL_USERS_PATH=path.join(__dirname, "eqsl-users.txt");
const LOTW_USERS_PATH=path.join(__dirname, "lotw-users.csv");

let cachedDictionary=null;
let cachedEqslUsers=null;
let cachedLotwUsers=null;

function loadDictionary(dictPath=DICT_PATH) {
    if (!cachedDictionary||dictPath!==DICT_PATH) {
        const raw=fs.readFileSync(dictPath, "utf8");
        cachedDictionary=JSON.parse(raw);
    }

    return cachedDictionary;
}

function loadEqslUsers(filePath=EQSL_USERS_PATH) {
    if (!cachedEqslUsers||filePath!==EQSL_USERS_PATH) {
        const raw=fs.readFileSync(filePath, "utf8");
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

function loadLotwUsers(filePath=LOTW_USERS_PATH) {
    if (!cachedLotwUsers||filePath!==LOTW_USERS_PATH) {
        const raw=fs.readFileSync(filePath, "utf8");
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

function lookupCallsignInfo(callsign, dictPath=DICT_PATH) {
    if (typeof callsign!=="string"||!callsign.trim()) {
        throw new Error("The callsign must be a non-empty string.");
    }

    const dictionary=loadDictionary(dictPath);
    const eqslUsers=loadEqslUsers();
    const lotwUsers=loadLotwUsers();
    const normalized=callsign.trim().toUpperCase();
    const eqsl=existsInCallsignSet(normalized, eqslUsers);
    const lotw=existsInCallsignSet(normalized, lotwUsers);

    const buildResult=(matchedKey, entry) => ({
        searchedCallsign: normalized,
        matchedCallsign: matchedKey,
        data: entry,
        eqsl,
        lotw,
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
    };
}

module.exports={
    lookupCallsignInfo,
};

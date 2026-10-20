import { getAotyApiKey, getAotyApiKeyRevision } from "./aoty-settings";

const AOTY_ORIGIN = "https://www.albumoftheyear.org";
const AOTY_API_ORIGINS = ["https://aoty.prigoana.com", "https://aoty.edideaur.works"];
const PARSE_API_ORIGIN = "https://api.parse.bot/scraper/d9c42eb6-5bec-496f-a97d-2e8b9cc8521d";
const PARSE_REQUEST_TIMEOUT_MS = 20_000;
const SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 100;

export interface AotyAlbumRatings {
    url: string;
    criticScore: number | null;
    userScore: number | null;
}

interface AlbumSearchResult extends AotyAlbumRatings {
    title: string;
    artist: string;
}

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const albumResultsCache = new Map<string, CacheEntry<AlbumSearchResult | null>>();
const artistPageCache = new Map<string, CacheEntry<string | null>>();
const pendingAlbumResults = new Map<string, Promise<AlbumSearchResult | null>>();
const pendingArtistPages = new Map<string, Promise<string | null>>();

function normalize(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/&amp;/g, " and ")
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number): T {
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (!oldestKey) break;
        cache.delete(oldestKey);
    }
    return value;
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }
    // Refresh insertion order for a small, bounded LRU cache.
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
}

function searchUrl(query: string, category?: "albums" | "artists"): string {
    const url = new URL(category ? `/search/${category}/` : "/search/", AOTY_ORIGIN);
    url.searchParams.set("q", query.slice(0, 240));
    return url.toString();
}

export function makeAotySearchUrl(query: string, category?: "albums" | "artists"): string {
    return searchUrl(query, category);
}

function apiUrl(origin: string, path: string, query: Record<string, string>): string {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
}

async function getApiJson(path: string, query: Record<string, string>): Promise<unknown | null> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);
    try {
        // This is a public, unofficial AOTY community API. Never send Spotify
        // session credentials or any Spotify account data to the service.
        // Both deployments currently exist; try the second only if the first
        // errors, so one unhealthy community host does not disable AOTY scores.
        for (const origin of AOTY_API_ORIGINS) {
            try {
                const response = await fetch(apiUrl(origin, path, query), {
                    method: "GET",
                    mode: "cors",
                    credentials: "omit",
                    headers: { Accept: "application/json" },
                    signal: controller.signal,
                });
                if (!response.ok) continue;
                return await response.json();
            } catch {
                if (controller.signal.aborted) break;
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeAotyUrl(value: unknown, pathPrefix: "album" | "artist"): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
        const url = new URL(value, AOTY_ORIGIN);
        if (url.origin !== AOTY_ORIGIN || !url.pathname.startsWith(`/${pathPrefix}/`)) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function phraseIncluded(haystack: string, phrase: string): boolean {
    if (!haystack || !phrase) return false;
    return ` ${haystack} `.includes(` ${phrase} `);
}

function similarity(expected: string, actual: string): number {
    if (!expected || !actual) return 0;
    if (expected === actual) return 1;
    if (phraseIncluded(actual, expected) || phraseIncluded(expected, actual)) return 0.95;
    const expectedWords = new Set(expected.split(" "));
    const actualWords = new Set(actual.split(" "));
    const shared = [...expectedWords].filter((word) => actualWords.has(word)).length;
    return shared / Math.max(expectedWords.size, 1);
}

function scoreFrom(value: unknown): number | null {
    const score = typeof value === "number"
        ? value
        : typeof value === "string" && /^\s*\d{1,3}(?:\s*\/\s*100|\s*%)?\s*$/.test(value)
          ? Number.parseInt(value, 10)
          : Number.NaN;
    return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
}

function searchKey(albumName: string, artistNames: string[]): string {
    return `${normalize(albumName)}|${artistNames.map(normalize).join("|")}`;
}

async function findAlbumResult(albumName: string, artistNames: string[], preferredScore?: "critic" | "user"): Promise<AlbumSearchResult | null> {
    const key = `${getAotyApiKeyRevision()}|${preferredScore ?? "link"}|${searchKey(albumName, artistNames)}`;
    const existing = cached(albumResultsCache, key);
    if (existing !== undefined) return existing;
    const pending = pendingAlbumResults.get(key);
    if (pending) return pending;

    const work = (async () => {
        const query = [albumName, artistNames[0]].filter(Boolean).join(" ");
        const apiKey = getAotyApiKey();
        let result: AlbumSearchResult | null = null;

        // A keyed Parse lookup also provides the canonical album URL. Use it
        // for menu links as well as scores; otherwise links fall back to the
        // community API even when the user has configured Parse.
        if (apiKey) {
            result = await findParseAlbumResult(query, albumName, artistNames, apiKey);
        }

        const preferredRating = preferredScore === "critic" ? result?.criticScore : result?.userScore;
        if (!result || preferredRating === null || preferredRating === undefined) {
            const payload = await getApiJson("/search/albums", { q: query });
            const communityResult = findCommunityAlbumResult(payload, albumName, artistNames);
            if (communityResult) {
                result = result
                    ? {
                          ...communityResult,
                          ...result,
                          criticScore: result.criticScore ?? communityResult.criticScore,
                          userScore: result.userScore ?? communityResult.userScore,
                      }
                    : communityResult;
            }
        }

        const resolvedPreferredRating = preferredScore === "critic" ? result?.criticScore : result?.userScore;
        const hasRequestedScore = preferredScore
            ? resolvedPreferredRating !== null && resolvedPreferredRating !== undefined
            : Boolean(result && (result.criticScore !== null || result.userScore !== null));
        return remember(albumResultsCache, key, result, hasRequestedScore ? SUCCESS_TTL_MS : result ? MISS_TTL_MS : ERROR_TTL_MS);
    })().finally(() => pendingAlbumResults.delete(key));

    pendingAlbumResults.set(key, work);
    return work;
}

function findCommunityAlbumResult(payload: unknown, albumName: string, artistNames: string[]): AlbumSearchResult | null {
    if (!isRecord(payload) || !Array.isArray(payload.albums)) return null;

    const expectedTitle = normalize(albumName);
    const expectedArtists = artistNames.map(normalize).filter(Boolean);
    const candidates: Array<{ result: AlbumSearchResult; relevance: number }> = [];
    for (const item of payload.albums) {
        if (!isRecord(item)) continue;
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const artist = typeof item.artist === "string" ? item.artist.trim() : "";
        const url = safeAotyUrl(item.url, "album");
        if (!title || !artist || !url) continue;

        const titleMatch = similarity(expectedTitle, normalize(title));
        const artistMatch = Math.max(0, ...expectedArtists.map((expected) => similarity(expected, normalize(artist))));
        if (titleMatch < 0.86 || artistMatch < 0.8) continue;

        candidates.push({
            result: { title, artist, url, criticScore: scoreFrom(item.criticScore), userScore: scoreFrom(item.userScore) },
            relevance: titleMatch + artistMatch,
        });
    }
    candidates.sort((left, right) => right.relevance - left.relevance);
    return candidates[0]?.result ?? null;
}

interface ParseApiResponse {
    status: number | null;
    payload: unknown | null;
}

async function requestParseApi(endpoint: string, query: Record<string, string>, apiKey: string): Promise<ParseApiResponse> {
    const url = new URL(endpoint, `${PARSE_API_ORIGIN}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PARSE_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url.toString(), {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            headers: { Accept: "application/json", "X-API-Key": apiKey },
            signal: controller.signal,
        });
        if (!response.ok) return { status: response.status, payload: null };
        return { status: response.status, payload: await response.json() };
    } catch {
        return { status: null, payload: null };
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function getParseApiJson(endpoint: string, query: Record<string, string>, apiKey: string): Promise<unknown | null> {
    return (await requestParseApi(endpoint, query, apiKey)).payload;
}

function parseApiFailure(status: number | null, context: string): string {
    if (status === null) return `Could not reach Parse for ${context}. Check your connection and try again.`;
    if (status === 401) return `Parse returned HTTP 401 for ${context}: it did not accept this API key. Check that the key is active and copied in full.`;
    if (status === 403) return `Parse returned HTTP 403 for ${context}: access was denied. This can be an API/account permission issue and does not necessarily mean the key itself is invalid.`;
    if (status === 402) return `Parse returned HTTP 402 for ${context}: check your Parse credits or plan.`;
    if (status === 404) return `Parse returned HTTP 404 for ${context}: the AOTY API endpoint may have moved or been removed.`;
    if (status === 429) return `Parse rate-limited ${context}. Wait a minute, then try again.`;
    return `Parse returned HTTP ${status} for ${context}.`;
}

function responseData(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) return null;
    return isRecord(payload.data) ? payload.data : payload;
}

async function findParseAlbumResult(query: string, albumName: string, artistNames: string[], apiKey: string): Promise<AlbumSearchResult | null> {
    const expectedTitle = normalize(albumName);
    const expectedArtists = artistNames.map(normalize).filter(Boolean);
    // Parse searches against album and artist names. Searching the album title
    // first is important: a combined "title artist" phrase can fail when an
    // API implementation matches the query against each field separately.
    // Only pay for the second search if the title-only results contain no
    // exact-enough album/artist match.
    const queries = [...new Set([albumName.trim(), query.trim()].filter(Boolean))];
    let match: { title: string; artist: string; url: string; path: string } | null = null;
    for (const searchQuery of queries) {
        const payload = await getParseApiJson("search_albums", { page: "1", query: searchQuery }, apiKey);
        const data = responseData(payload);
        if (!data || !Array.isArray(data.results)) continue;

        const candidates: Array<{ title: string; artist: string; url: string; path: string; relevance: number }> = [];
        for (const value of data.results) {
            if (!isRecord(value)) continue;
            const titleValue = value.album_title ?? value.title;
            const artistValue = value.artist ?? value.artist_name;
            const title = typeof titleValue === "string" ? titleValue.trim() : "";
            const artist = typeof artistValue === "string"
                ? artistValue.trim()
                : Array.isArray(value.artists)
                  ? value.artists.filter((name): name is string => typeof name === "string").join(" ").trim()
                  : "";
            const path = typeof value.path === "string" ? value.path : "";
            const url = safeAotyUrl(value.full_url ?? path, "album");
            // AOTY routes may contain a .php suffix and Parse deployments can
            // return nested album paths. Require a local /album/ path, but don't
            // reject a valid canonical route just because it has extra segments.
            if (!title || !artist || !url || !/^\/album\/[^?#]+$/.test(path) || path.includes("..")) continue;

            const titleMatch = similarity(expectedTitle, normalize(title));
            const artistMatch = Math.max(0, ...expectedArtists.map((expected) => similarity(expected, normalize(artist))));
            if (titleMatch < 0.86 || artistMatch < 0.8) continue;
            candidates.push({ title, artist, url, path, relevance: titleMatch + artistMatch });
        }
        candidates.sort((left, right) => right.relevance - left.relevance);
        if (candidates[0]) {
            const { title, artist, url, path } = candidates[0];
            match = { title, artist, url, path };
            break;
        }
    }
    if (!match) return null;

    const detailsPayload = await getParseApiJson("get_album_details", { album_path: match.path }, apiKey);
    const details = responseData(detailsPayload);
    if (!details) return null;

    return {
        title: match.title,
        artist: match.artist,
        url: match.url,
        criticScore: scoreFrom(details.critic_score ?? details.criticScore),
        userScore: scoreFrom(details.user_score ?? details.userScore),
    };
}

export async function testAotyApiKey(): Promise<string> {
    const apiKey = getAotyApiKey();
    if (!apiKey) return "Save a Parse API key first.";

    const searchResponse = await requestParseApi("search_albums", { page: "1", query: "Radiohead" }, apiKey);
    if (searchResponse.status === null || searchResponse.status < 200 || searchResponse.status >= 300) {
        return parseApiFailure(searchResponse.status, "album search");
    }

    const searchData = responseData(searchResponse.payload);
    const results = Array.isArray(searchData?.results) ? searchData.results : [];
    const match = results.find((item) => isRecord(item) && typeof item.path === "string" && /^\/album\/[^?#]+$/.test(item.path) && !item.path.includes(".."));
    if (!isRecord(match) || typeof match.path !== "string") {
        return "The key works, but album search returned an unexpected response. The API schema may have changed.";
    }

    const detailsResponse = await requestParseApi("get_album_details", { album_path: match.path }, apiKey);
    if (detailsResponse.status === null || detailsResponse.status < 200 || detailsResponse.status >= 300) {
        return `Search worked, but ${parseApiFailure(detailsResponse.status, "score details")}`;
    }

    const details = responseData(detailsResponse.payload);
    if (!details || !("critic_score" in details) && !("user_score" in details)) {
        return "The key works, but the score-details response has no critic_score/user_score fields.";
    }
    const criticScore = scoreFrom(details.critic_score ?? details.criticScore);
    const userScore = scoreFrom(details.user_score ?? details.userScore);
    if (criticScore === null && userScore === null) {
        return "The key and endpoints work, but the test album has no aggregate critic or user score.";
    }
    return `Parse lookup works: critic ${criticScore ?? "—"}/100, user ${userScore ?? "—"}/100. Only aggregate scores are used.`;
}

export async function findAotyAlbumPage(albumName: string, artistNames: string[]): Promise<string | null> {
    return (await findAlbumResult(albumName, artistNames))?.url ?? null;
}

export async function getAotyAlbumRatings(albumName: string, artistNames: string[], preferredScore: "critic" | "user"): Promise<AotyAlbumRatings | null> {
    const result = await findAlbumResult(albumName, artistNames, preferredScore);
    if (!result) return null;
    return {
        url: result.url,
        criticScore: result.criticScore,
        userScore: result.userScore,
    };
}

export async function findAotyArtistPage(artistName: string): Promise<string | null> {
    const key = normalize(artistName);
    const existing = cached(artistPageCache, key);
    if (existing !== undefined) return existing;
    const pending = pendingArtistPages.get(key);
    if (pending) return pending;

    const work = (async () => {
        const payload = await getApiJson("/search/artists", { q: artistName });
        if (!isRecord(payload) || !Array.isArray(payload.artists)) {
            return remember(artistPageCache, key, null, ERROR_TTL_MS);
        }

        const expected = normalize(artistName);
        const candidates: Array<{ url: string; relevance: number }> = [];
        for (const item of payload.artists) {
            if (!isRecord(item) || typeof item.name !== "string") continue;
            const url = safeAotyUrl(item.url, "artist");
            if (!url) continue;
            const relevance = similarity(expected, normalize(item.name));
            if (relevance < 0.86) continue;
            candidates.push({ url, relevance });
        }

        candidates.sort((left, right) => right.relevance - left.relevance);
        const result = candidates[0]?.url ?? null;
        return remember(artistPageCache, key, result, result ? SUCCESS_TTL_MS : MISS_TTL_MS);
    })().finally(() => pendingArtistPages.delete(key));

    pendingArtistPages.set(key, work);
    return work;
}

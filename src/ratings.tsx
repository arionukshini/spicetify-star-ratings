import * as api from "./api";
import { getTrackRatingOrDefault } from "./app";
import { PlaylistUris, Ratings, TimestampedRating, Track } from "./types/store";
interface Contents {
    uri?: string;
    items: [
        {
            type: string;
            uri: string;
            name: string;
        },
    ];
}

export function findFolderByUri(contents: Contents, uri: string): Contents | undefined {
    // A folder item in the Spotify rootlist has its own .items sub-array at runtime,
    // so it structurally satisfies Contents even though the interface tuple does not declare it.
    return contents.items.find((item) => item.type === "folder" && item.uri === uri) as Contents | undefined;
}

export function findFolderByName(contents: Contents, name: string): Contents | undefined {
    return contents.items.find((item) => item.type === "folder" && item.name === name) as Contents | undefined;
}

/**
 * Parse a rating playlist name into a base rating and a 1-based version number.
 *
 * Supported formats:
 *   "4.5"    -> { rating: "4.5", version: 1 }   (first / only playlist)
 *   "4.5(1)" -> { rating: "4.5", version: 2 }   (first spillover)
 *   "4.5(2)" -> { rating: "4.5", version: 3 }   (second spillover)
 *
 * Returns null if the name does not match.
 */
export function parseRatingPlaylistName(name: string): { rating: number; version: number } | null {
    const toSupportedRating = (value: string): number | null => {
        const rating = Number(value);
        return Number.isFinite(rating) && rating >= 0 && rating <= 5 && Number.isInteger(rating * 4) ? rating : null;
    };

    // Base name with no suffix: "4.5"
    const baseMatch = name.match(/^(\d+(?:\.\d+)?)$/);
    if (baseMatch) {
        const rating = toSupportedRating(baseMatch[1]);
        return rating === null ? null : { rating, version: 1 };
    }
    // Spillover suffix: "4.5(1)", "4.5(2)", …
    const overflowMatch = name.match(/^(\d+(?:\.\d+)?)\((\d+)\)$/);
    if (overflowMatch) {
        const rating = toSupportedRating(overflowMatch[1]);
        const suffix = Number(overflowMatch[2]);
        return rating === null || !Number.isSafeInteger(suffix) || suffix >= Number.MAX_SAFE_INTEGER
            ? null
            : { rating, version: suffix + 1 };
    }
    return null;
}

/**
 * Build a PlaylistUris map by scanning the contents of the rated folder.
 * Playlists are grouped by base rating and sorted by version (ascending),
 * so the last element in each array is always the newest / highest-version playlist.
 */
export function buildPlaylistUris(ratedFolder: Contents): PlaylistUris {
    const grouped = new Map<number, { uri: string; version: number }[]>();

    for (const item of ratedFolder.items) {
        if (item.type !== "playlist") continue;
        const parsed = parseRatingPlaylistName(item.name);
        if (!parsed) continue;
        if (!grouped.has(parsed.rating)) grouped.set(parsed.rating, []);
        grouped.get(parsed.rating)!.push({ uri: item.uri, version: parsed.version });
    }

    const result: PlaylistUris = {};
    for (const [rating, items] of grouped) {
        result[rating] = items.sort((a, b) => a.version - b.version).map((i) => i.uri);
    }
    return result;
}

export function getPlaylistNames(playlistUris: PlaylistUris, ratedFolder: Contents): Record<string, string> {
    const allUris = new Set(Object.values(playlistUris).flat());
    const playlistNames: Record<string, string> = {};
    ratedFolder.items
        .filter((item) => allUris.has(item.uri))
        .forEach((item) => {
            playlistNames[item.uri] = item.name;
        });
    return playlistNames;
}

type PlaylistItemsEntry = { rating: number; playlistUri: string; tracks: Track[] };

/**
 * Return Spotify's stable identifier for one occurrence of a track in a
 * playlist. Spotify has switched between `uid` and `rowId` in its client
 * responses, so every move/remove operation must use the same fallback.
 */
export function getPlaylistItemId(track: Pick<Track, "uid" | "rowId">): string | null {
    const id = track.uid ?? track.rowId;
    return typeof id === "string" && id.length > 0 ? id : null;
}

export async function getAllPlaylistItems(playlistUris: PlaylistUris): Promise<PlaylistItemsEntry[]> {
    const entries: { rating: number; playlistUri: string }[] = [];
    // Object.entries always yields string keys; parse back to number.
    for (const [ratingStr, uris] of Object.entries(playlistUris)) {
        const rating = parseFloat(ratingStr);
        for (const playlistUri of uris) {
            entries.push({ rating, playlistUri });
        }
    }
    const trackArrays: Track[][] = new Array(entries.length);
    let nextIndex = 0;
    const workerCount = Math.min(4, entries.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < entries.length) {
                const index = nextIndex++;
                trackArrays[index] = (await api.getPlaylistItems(entries[index].playlistUri)) as Track[];
            }
        }),
    );
    return entries.map((e, i) => ({ ...e, tracks: trackArrays[i] }));
}

function normalizeTrackRatings(entries: TimestampedRating[]): TimestampedRating[] {
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const sortedEntries = [...entries].sort((a, b) => a.time.getTime() - b.time.getTime());
    const normalized: TimestampedRating[] = [];

    for (const entry of sortedEntries) {
        const previous = normalized[normalized.length - 1];
        if (!previous) {
            normalized.push(entry);
            continue;
        }

        if (entry.time.getTime() - previous.time.getTime() <= FIVE_MIN_MS) {
            if (entry.rating === previous.rating) {
                normalized.pop();
            } else {
                normalized[normalized.length - 1] = entry;
            }
            continue;
        }

        normalized.push(entry);
    }

    return normalized.sort((a, b) => b.time.getTime() - a.time.getTime());
}

export function getRatingsByTrack(allPlaylistItems: PlaylistItemsEntry[]): Ratings {
    const ratingsByTrack: { [trackUri: string]: TimestampedRating[] } = {};

    for (const { rating, playlistUri, tracks } of allPlaylistItems) {
        for (const track of tracks) {
            const trackUri = track.link ?? track.uri;
            const playlistItemId = getPlaylistItemId(track);
            const addedAt = new Date(track.addedAt);
            if (
                typeof trackUri !== "string" ||
                !playlistItemId ||
                !Number.isFinite(rating) ||
                rating < 0 ||
                rating > 5 ||
                !Number.isInteger(rating * 4) ||
                !Number.isFinite(addedAt.getTime())
            ) {
                console.warn("Skipping a rating playlist item without a track URI or playlist-item ID", track);
                continue;
            }

            const entry: TimestampedRating = {
                rating,
                time: addedAt,
                uid: playlistItemId,
                playlistUri,
            };

            if (!ratingsByTrack[trackUri]) {
                ratingsByTrack[trackUri] = [entry];
            } else {
                ratingsByTrack[trackUri].push(entry);
            }
        }
    }

    const normalizedRatings: Ratings = {};
    for (const [trackUri, entries] of Object.entries(ratingsByTrack)) {
        normalizedRatings[trackUri] = normalizeTrackRatings(entries);
    }

    return normalizedRatings;
}

/**
 * Merge the freshly-fetched contents of a single rating playlist into the
 * ratings map, without re-scanning the whole corpus.
 *
 * Used after adding a track, when we need the new entry's uid (the add call
 * does not return it). The just-added entry is identified as the matching
 * track with the most recent add time. The affected track's entries are
 * re-normalized so the result matches what a full `getRatingsByTrack` pass
 * would produce.
 *
 * Returns the just-added entry, or undefined if the track wasn't found in the
 * playlist's contents.
 */
export function mergeAddedTrack(
    ratings: Ratings,
    playlistUri: string,
    rating: number,
    trackUri: string,
    tracks: Track[],
): TimestampedRating | undefined {
    const candidates = tracks.filter((track) => (track.link ?? track.uri) === trackUri && getPlaylistItemId(track));
    if (candidates.length === 0) return undefined;

    // The just-added entry has the most recent add time.
    const added = candidates.reduce((prev, current) =>
        new Date(current.addedAt).getTime() > new Date(prev.addedAt).getTime() ? current : prev,
    );
    const playlistItemId = getPlaylistItemId(added);
    if (!playlistItemId) return undefined;

    const entry: TimestampedRating = {
        rating,
        time: new Date(added.addedAt),
        uid: playlistItemId,
        playlistUri,
    };

    const existing = ratings[trackUri] ?? [];
    if (!existing.some((e) => e.playlistUri === playlistUri && e.uid === entry.uid)) {
        ratings[trackUri] = normalizeTrackRatings([...existing, entry]);
    }

    return entry;
}

export function getCanonicalRating(ratings: Ratings, trackUri: string): number | null {
    const trackRatings = ratings[trackUri];
    if (!trackRatings || trackRatings.length === 0) return null;

    // Time-weighted average with half-life of 6 months. Keep this calculation
    // here so album averages use the same canonical track rating as the stars
    // shown elsewhere in the extension.
    const HALF_LIFE_MS = 6 * (365.25 / 12) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let weightedSum = 0;
    let weightSum = 0;

    for (const { rating, time } of trackRatings) {
        const weight = Math.pow(0.5, (now - time.getTime()) / HALF_LIFE_MS);
        weightedSum += rating * weight;
        weightSum += weight;
    }

    return weightSum > 0 ? weightedSum / weightSum : null;
}

export interface AlbumRatingDetails {
    average: number | null;
    ratedTracks: number;
    totalTracks: number;
}

type AlbumTrackForRating = {
    uri?: string;
    linked_from?: { uri?: string };
};

type AlbumForRating = {
    tracks?: { items?: AlbumTrackForRating[] };
};

export function getAlbumRatingDetails(ratings: Ratings, album?: AlbumForRating | null): AlbumRatingDetails {
    const items = Array.isArray(album?.tracks?.items) ? album.tracks.items : [];
    let sumRatings = 0;
    let ratedTracks = 0;

    for (const item of items) {
        // linked_from is present for some unavailable/relinked album tracks.
        // Prefer the visible track URI, but accept the original URI when that
        // is the one stored in the user's rating playlists.
        const trackUris = [item?.uri, item?.linked_from?.uri].filter(
            (uri, index, all): uri is string => typeof uri === "string" && all.indexOf(uri) === index,
        );
        const trackUri = trackUris.find((uri) => ratings[uri]?.length > 0);
        if (!trackUri) continue;

        const rating = getCanonicalRating(ratings, trackUri);
        if (rating === null || !Number.isFinite(rating)) continue;

        sumRatings += rating;
        ratedTracks += 1;
    }

    if (ratedTracks === 0) {
        return { average: null, ratedTracks: 0, totalTracks: items.length };
    }

    // Quarter-star precision is the finest precision supported by the star UI.
    const average = Math.round((sumRatings / ratedTracks) * 4) / 4;
    return { average, ratedTracks, totalTracks: items.length };
}

export function getAlbumRating(ratings: Ratings, album?: AlbumForRating | null): number | null {
    return getAlbumRatingDetails(ratings, album).average;
}

export async function sortPlaylistByRating(playlistUri: string, ratings: Ratings) {
    const items = (await api.getPlaylistItems(playlistUri)) as Track[];

    if (items.length < 2) return;

    const sorted = items
        .map((item, idx) => {
            const playlistItemId = getPlaylistItemId(item);
            const trackUri = item.link ?? item.uri;
            return playlistItemId && typeof trackUri === "string"
                ? { uid: playlistItemId, rating: getTrackRatingOrDefault(trackUri), idx }
                : null;
        })
        .filter((item): item is { uid: string; rating: number; idx: number } => item !== null)
        .sort((a, b) => b.rating - a.rating || a.idx - b.idx)
        .map((item) => item.uid);

    if (sorted.length < 2) return;

    // Use lowest-rated track as anchor, then insert tracks in descending-rating order before it.
    const anchor = sorted[sorted.length - 1];

    // One batched move per 50 tracks avoids thousands of round trips on large
    // playlists while keeping each request comfortably sized.
    const batchSize = 50;
    const tracksToMove = sorted.slice(0, -1);
    for (let i = 0; i < tracksToMove.length; i += batchSize) {
        await api.moveTracksBefore(playlistUri, tracksToMove.slice(i, i + batchSize), anchor);
    }
}

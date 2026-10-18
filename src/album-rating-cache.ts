import * as api from "./api";

const STORAGE_KEY = "starRatings:albumRatingCache";
const MAX_ENTRIES = 500;

export type CachedAlbumRating = {
    average: number;
    ratedTracks: number;
    totalTracks: number;
    updatedAt: number;
};

type AlbumRatingCache = Record<string, CachedAlbumRating>;
let albumRatingCache: AlbumRatingCache | null = null;

function loadCache(): AlbumRatingCache {
    if (albumRatingCache) return albumRatingCache;

    try {
        const value = api.getLocalStorageData(STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            albumRatingCache = {};
            return albumRatingCache;
        }

        albumRatingCache = Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, CachedAlbumRating] => {
                const value = entry[1] as Partial<CachedAlbumRating> | null;
                return (
                    !!value &&
                    typeof value.average === "number" &&
                    Number.isFinite(value.average) &&
                    value.average >= 0 &&
                    value.average <= 5 &&
                    typeof value.ratedTracks === "number" &&
                    Number.isFinite(value.ratedTracks) &&
                    typeof value.totalTracks === "number" &&
                    Number.isFinite(value.totalTracks) &&
                    typeof value.updatedAt === "number" &&
                    Number.isFinite(value.updatedAt)
                );
            }),
        );
        return albumRatingCache;
    } catch (error) {
        console.warn("Could not read the local album-rating cache:", error);
        albumRatingCache = {};
        return albumRatingCache;
    }
}

function saveCache(cache: AlbumRatingCache) {
    try {
        const entries = Object.entries(cache)
            .filter(([, value]) => value && Number.isFinite(value.average) && Number.isFinite(value.updatedAt))
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_ENTRIES);
        albumRatingCache = Object.fromEntries(entries);
        api.setLocalStorageData(STORAGE_KEY, JSON.stringify(albumRatingCache));
    } catch (error) {
        console.warn("Could not save the local album-rating cache:", error);
    }
}

export function getCachedAlbumRating(albumId: string | null): CachedAlbumRating | null {
    if (!albumId) return null;
    const entry = loadCache()[albumId];
    return entry && Number.isFinite(entry.average) ? entry : null;
}

export function saveCachedAlbumRating(albumId: string | null, rating: Omit<CachedAlbumRating, "updatedAt">) {
    if (!albumId || !Number.isFinite(rating.average) || rating.ratedTracks <= 0) return;
    const cache = loadCache();
    cache[albumId] = { ...rating, updatedAt: Date.now() };
    saveCache(cache);
}

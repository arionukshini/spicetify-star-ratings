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

function loadCache(): AlbumRatingCache {
    try {
        const value = api.getLocalStorageData(STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        console.warn("Could not read the local album-rating cache:", error);
        return {};
    }
}

function saveCache(cache: AlbumRatingCache) {
    try {
        const entries = Object.entries(cache)
            .filter(([, value]) => value && Number.isFinite(value.average) && Number.isFinite(value.updatedAt))
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_ENTRIES);
        api.setLocalStorageData(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
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

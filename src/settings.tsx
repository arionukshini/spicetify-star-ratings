import * as api from "./api";
import { playlistUris } from "./app";
import { PlaylistUris } from "./types/store";

type HalfIncrementRating = "0.0" | "0.5" | "1.0" | "1.5" | "2.0" | "2.5" | "3.0" | "3.5" | "4.0" | "4.5" | "5.0";
type QuarterIncrementRating =
    | "0.0"
    | "0.25"
    | "0.5"
    | "0.75"
    | "1.0"
    | "1.25"
    | "1.5"
    | "1.75"
    | "2.0"
    | "2.25"
    | "2.5"
    | "2.75"
    | "3.0"
    | "3.25"
    | "3.5"
    | "3.75"
    | "4.0"
    | "4.25"
    | "4.5"
    | "4.75"
    | "5.0";

type NowPlayingStarsPosition = "left" | "right";
type NewRatingPosition = "front" | "back";
type Threshold = "disabled" | HalfIncrementRating;

export type Play = "all" | "onlyrated" | "onlyunrated";
export type Scaling = { kind: "Linear" } | { kind: "Exponential"; base: number };
export type AotyScoreType = "critic" | "user";

export interface Settings {
    halfStarRatings: boolean;
    quarterStarRatings: boolean;
    likeThreshold: Threshold;
    enableKeyboardShortcuts: boolean;
    showPlaylistStars: boolean;
    maxPlaylistItems: number;
    nowPlayingStarsPosition: NowPlayingStarsPosition;
    newRatingPosition: NewRatingPosition;
    skipThreshold: Threshold;
    syncDuplicateSongs: boolean;
    defaultRating: HalfIncrementRating;
    reEnqueueWorkaround: boolean;
    averageRatings: boolean;
    showExactRating: boolean;
    ratingToWeight: Scaling;
    play: Play;
    showWeightedShuffle: boolean;
    showAotyAlbumScore: boolean;
    aotyScoreType: AotyScoreType;
    openAlbumsInAoty: boolean;
    openArtistsInAoty: boolean;
}

const halfIncrementRatings: HalfIncrementRating[] = ["0.0", "0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "4.5", "5.0"];
const thresholds: Threshold[] = ["disabled", ...halfIncrementRatings];

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

const defaultSettings: Settings = {
    halfStarRatings: true,
    quarterStarRatings: false,
    likeThreshold: "4.0",
    enableKeyboardShortcuts: true,
    showPlaylistStars: true,
    /* Spotify's hard limit is 10,000 */
    maxPlaylistItems: 1000,
    nowPlayingStarsPosition: "left",
    newRatingPosition: "front",
    skipThreshold: "disabled",
    syncDuplicateSongs: false,
    defaultRating: "2.5",
    reEnqueueWorkaround: false,
    averageRatings: false,
    showExactRating: false,
    ratingToWeight: { kind: "Linear" },
    play: "all",
    showWeightedShuffle: true,
    showAotyAlbumScore: false,
    aotyScoreType: "critic",
    openAlbumsInAoty: false,
    openArtistsInAoty: false,
};

export function getSettings(): Settings {
    let stored: unknown;
    try {
        const raw = api.getLocalStorageData("starRatings:settings");
        stored = raw ? JSON.parse(raw) : {};
    } catch {
        stored = {};
    }

    const values = isRecord(stored) ? stored : {};
    const settings: Settings = { ...defaultSettings };
    let modified = false;
    for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
        if (!(key in values)) modified = true;
    }

    const useBoolean = (key: keyof Settings) => {
        const value = values[key];
        if (typeof value === "boolean") settings[key] = value as never;
        else if (key in values) modified = true;
    };
    useBoolean("halfStarRatings");
    useBoolean("quarterStarRatings");
    useBoolean("enableKeyboardShortcuts");
    useBoolean("showPlaylistStars");
    useBoolean("syncDuplicateSongs");
    useBoolean("reEnqueueWorkaround");
    useBoolean("averageRatings");
    useBoolean("showExactRating");
    useBoolean("showWeightedShuffle");
    useBoolean("showAotyAlbumScore");
    useBoolean("openAlbumsInAoty");
    useBoolean("openArtistsInAoty");

    if (values.aotyScoreType === "critic" || values.aotyScoreType === "user") {
        settings.aotyScoreType = values.aotyScoreType;
    } else if ("aotyScoreType" in values) {
        modified = true;
    }

    if (typeof values.maxPlaylistItems === "number" && Number.isFinite(values.maxPlaylistItems)) {
        settings.maxPlaylistItems = Math.max(1, Math.min(10000, Math.floor(values.maxPlaylistItems)));
        if (settings.maxPlaylistItems !== values.maxPlaylistItems) modified = true;
    } else if ("maxPlaylistItems" in values) {
        modified = true;
    }

    if (typeof values.nowPlayingStarsPosition === "string" && ["left", "right"].includes(values.nowPlayingStarsPosition)) {
        settings.nowPlayingStarsPosition = values.nowPlayingStarsPosition as NowPlayingStarsPosition;
    } else if ("nowPlayingStarsPosition" in values) {
        modified = true;
    }

    if (typeof values.newRatingPosition === "string" && ["front", "back"].includes(values.newRatingPosition)) {
        settings.newRatingPosition = values.newRatingPosition as NewRatingPosition;
    } else if ("newRatingPosition" in values) {
        modified = true;
    }

    if (typeof values.likeThreshold === "string" && thresholds.includes(values.likeThreshold as Threshold)) {
        settings.likeThreshold = values.likeThreshold as Threshold;
    } else if ("likeThreshold" in values) {
        modified = true;
    }

    if (typeof values.skipThreshold === "string" && thresholds.includes(values.skipThreshold as Threshold)) {
        settings.skipThreshold = values.skipThreshold as Threshold;
    } else if ("skipThreshold" in values) {
        modified = true;
    }

    if (typeof values.defaultRating === "string" && halfIncrementRatings.includes(values.defaultRating as HalfIncrementRating)) {
        settings.defaultRating = values.defaultRating as HalfIncrementRating;
    } else if ("defaultRating" in values) {
        modified = true;
    }

    if (values.ratingToWeight === null || typeof values.ratingToWeight !== "object" || Array.isArray(values.ratingToWeight)) {
        if ("ratingToWeight" in values) modified = true;
    } else {
        const scaling = values.ratingToWeight as Record<string, unknown>;
        if (scaling.kind === "Linear") {
            settings.ratingToWeight = { kind: "Linear" };
        } else if (
            scaling.kind === "Exponential" &&
            typeof scaling.base === "number" &&
            Number.isFinite(scaling.base) &&
            scaling.base >= 0.01
        ) {
            settings.ratingToWeight = { kind: "Exponential", base: Math.min(100, scaling.base) };
            if (settings.ratingToWeight.base !== scaling.base) modified = true;
        } else {
            modified = true;
        }
    }

    if (values.play === "all" || values.play === "onlyrated" || values.play === "onlyunrated") {
        settings.play = values.play;
    } else if ("play" in values) {
        modified = true;
    }

    if (modified || !isRecord(stored)) {
        api.setLocalStorageData("starRatings:settings", JSON.stringify(settings));
    }
    return settings;
}

export function saveSettings(settings: Settings) {
    api.setLocalStorageData("starRatings:settings", JSON.stringify(settings));
}

export function getPlaylistUris(): PlaylistUris {
    try {
        const raw = api.getLocalStorageData("starRatings:playlistUris");
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object") {
            const migrated: PlaylistUris = {};
            for (const [ratingStr, value] of Object.entries(parsed)) {
                const rating = Number(ratingStr);
                if (!Number.isFinite(rating) || rating < 0 || rating > 5 || Math.round(rating * 4) !== rating * 4) continue;
                if (Array.isArray(value)) {
                    migrated[rating] = value.filter((uri): uri is string => typeof uri === "string" && uri.length > 0);
                } else if (typeof value === "string" && value.length > 0) {
                    migrated[rating] = [value];
                }
            }
            return migrated;
        }
        throw "";
    } catch {
        api.setLocalStorageData("starRatings:playlistUris", `{}`);
        return {};
    }
}

export function savePlaylistUris(uris: PlaylistUris = playlistUris) {
    api.setLocalStorageData("starRatings:playlistUris", JSON.stringify(uris));
}

export function getRatedFolderUri() {
    return api.getLocalStorageData("starRatings:ratedFolderUri");
}

export function saveRatedFolderUri(ratedFolderUri: string) {
    api.setLocalStorageData("starRatings:ratedFolderUri", ratedFolderUri);
}

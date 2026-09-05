import { getLocalStorageData, setLocalStorageData } from "../api";

export function getTracklistTrackUri(tracklistElement: Element) {
    let values = Object.values(tracklistElement);
    if (!values) return null;

    const searchFrom = values[0]?.pendingProps?.children?.[0]?.props?.children ?? values[0]?.pendingProps?.children?.props?.value?.item;

    return (
        searchFrom?.uri ||
        searchFrom?.props?.uri ||
        searchFrom?.props?.children?.props?.uri ||
        searchFrom?.props?.children?.props?.children?.props?.uri ||
        searchFrom?.[0]?.props?.uri
    );
}

export function isAlbumPage() {
    const pathname = Spicetify.Platform.History.location.pathname;
    const matches = pathname.match(/^\/album\/([^/]+)/);
    return matches?.[1] ?? null;
}

export function trackUriToTrackId(trackUri: string): string {
    return trackUri.replace("spotify:track:", "");
}

export const getNowPlayingTrackUri = () => {
    return Spicetify.Player.data.item.uri;
};

// Get current player context (playlist, album, etc.)
export function getPlayerContext(): Spicetify.PlayerContext | null {
    return Spicetify.Player?.data?.context || Spicetify.Player?.data?.item?.context || null;
}

const WEIGHTED_PLAYBACK_ENABLED_LOCAL_STORAGE_KEY = "starRatings:weighted-playback-enabled";
let weightedPlaybackEnabledRecord: Record<string, boolean> | null = null;

function getWeightedPlaybackEnabledRecord(): Record<string, boolean> {
    if (weightedPlaybackEnabledRecord) return weightedPlaybackEnabledRecord;

    const localstorage = getLocalStorageData(WEIGHTED_PLAYBACK_ENABLED_LOCAL_STORAGE_KEY);

    try {
        if (!localstorage) {
            weightedPlaybackEnabledRecord = {};
            return weightedPlaybackEnabledRecord;
        }

        const parsed = JSON.parse(localstorage);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            weightedPlaybackEnabledRecord = {};
            return weightedPlaybackEnabledRecord;
        }

        weightedPlaybackEnabledRecord = parsed as Record<string, boolean>;
        return weightedPlaybackEnabledRecord;
    } catch (error) {
        console.warn("Could not read weighted playback settings:", error);
        weightedPlaybackEnabledRecord = {};
        return weightedPlaybackEnabledRecord;
    }
}

export function weightedPlaybackEnabledForPlaylist(): boolean {
    const context = getPlayerContext();
    const contextUri = context?.uri;
    if (typeof contextUri !== "string" || !contextUri) {
        return false;
    }

    const record = getWeightedPlaybackEnabledRecord();
    return record[contextUri] ?? false;
}

export function setWeightedPlaybackEnabledForPlaylist(enabled: boolean) {
    const context = getPlayerContext();
    const contextUri = context?.uri;
    if (typeof contextUri !== "string" || !contextUri) {
        return;
    }

    const record = getWeightedPlaybackEnabledRecord();
    record[contextUri] = enabled;
    setLocalStorageData(WEIGHTED_PLAYBACK_ENABLED_LOCAL_STORAGE_KEY, JSON.stringify(record));
}

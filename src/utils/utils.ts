import { getLocalStorageData, setLocalStorageData } from "../api";

export function getTracklistTrackUri(tracklistElement: Element) {
    try {
        for (const reactNode of Object.values(tracklistElement) as any[]) {
            const props = reactNode?.pendingProps ?? reactNode?.memoizedProps;
            if (!props) continue;

            const searchFrom = props?.children?.[0]?.props?.children ?? props?.children?.props?.value?.item;
            const candidates = [
                searchFrom,
                searchFrom?.props,
                searchFrom?.props?.children?.props,
                searchFrom?.props?.children?.props?.children?.props,
                searchFrom?.[0]?.props,
            ];
            const uri = candidates.map((candidate) => candidate?.uri).find((value) => typeof value === "string");
            if (uri) return uri;
        }
        return null;
    } catch {
        // Spotify changes the React props attached to track rows between builds.
        return null;
    }
}

export function isAlbumPage() {
    const pathname = Spicetify?.Platform?.History?.location?.pathname;
    if (typeof pathname !== "string") return null;
    const matches = pathname.match(/^\/album\/([^/]+)/);
    return matches?.[1] ?? null;
}

export function trackUriToTrackId(trackUri: string): string {
    return trackUri.replace("spotify:track:", "");
}

export const getNowPlayingTrackUri = () => Spicetify.Player?.data?.item?.uri ?? null;

// Get current player context (playlist, album, etc.)
export function getPlayerContext(): Spicetify.PlayerContext | null {
    return Spicetify.Player?.data?.context || (Spicetify.Player?.data?.item as any)?.context || null;
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

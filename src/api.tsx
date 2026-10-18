import type { Track } from "./types/store";

export function showNotification(text: string) {
    Spicetify.showNotification(text);
}

export function getLocalStorageData(key: string) {
    return Spicetify.LocalStorage.get(key);
}

export function setLocalStorageData(key: string, value: string) {
    Spicetify.LocalStorage.set(key, value);
}

const platformAPICache: Record<string, any> = {};
const platformAPIIdentities: Record<string, string[]> = {
    LibraryAPI: ["contains", "getTracks"],
    RootlistAPI: ["createFolder", "createPlaylist"],
    PlaylistAPI: ["add", "remove", "move"],
};

function getPlatformAPI(name: string, requiredMethods: string[]) {
    const platform = Spicetify?.Platform;
    const hasMethods = (value: any, methods: string[]) => methods.every((method) => typeof value?.[method] === "function");
    const isUsable = (value: any) => hasMethods(value, requiredMethods);
    const cached = platformAPICache[name];
    if (isUsable(cached)) return cached;

    const direct = platform?.[name];
    if (isUsable(direct)) {
        platformAPICache[name] = direct;
        return direct;
    }

    // Platform service registry entries have moved over time. Resolve by the
    // methods this extension needs instead of depending on their array order.
    const registeredValues = Array.from(platform?.Registry?._map?.values?.() ?? []) as any[];
    for (const entry of registeredValues) {
        const instance = entry?.instance ?? entry;
        const isKnownService = (platformAPIIdentities[name] ?? []).some((method) => typeof instance?.[method] === "function");
        if (isUsable(instance) && isKnownService) {
            platformAPICache[name] = instance;
            return instance;
        }
    }

    throw new Error(`Spotify ${name} is unavailable in this client version`);
}

function getLibraryAPI(requiredMethods: string[]) {
    return getPlatformAPI("LibraryAPI", requiredMethods);
}

function getRootlistAPI(requiredMethods: string[]) {
    return getPlatformAPI("RootlistAPI", requiredMethods);
}

function getPlaylistAPI(requiredMethods: string[]) {
    return getPlatformAPI("PlaylistAPI", requiredMethods);
}

export async function createPlaylist(name: string, folderUri: string) {
    const options =
        navigator.platform.startsWith("Linux") && navigator.userAgent.includes("Spotify/1.1.84.716")
            ? { after: folderUri }
            : { after: { uri: folderUri } };

    // try platformAPI first, fall back to api.spotify.com
    let rootlistAPI;
    try {
        rootlistAPI = getRootlistAPI(["createPlaylist"]);
    } catch {
        // Older Spotify builds expose playlist creation only through Cosmos.
    }
    if (rootlistAPI) return normalizePlaylistUri(await rootlistAPI.createPlaylist(name, options));

    const username = (Spicetify as any).User?.getUsername?.() ?? Spicetify.Platform.username;

    // The public Web API does not accept RootlistAPI's `after` placement
    // option. Create a private playlist with the supported request shape.
    // Folder placement is unavailable through this fallback, but the URI is
    // still usable by the rating store.
    if (folderUri) console.warn("RootlistAPI is unavailable; the new playlist cannot be placed in the Rated folder.");
    const result = await Spicetify.CosmosAsync.post(`https://api.spotify.com/v1/users/${username}/playlists`, {
        name,
        public: false,
        collaborative: false,
    });
    return normalizePlaylistUri(result);
}

function normalizePlaylistUri(result: any): string {
    if (typeof result === "string" && result.length > 0) return result;
    const uri = result?.uri ?? result?.playlist?.uri;
    if (typeof uri === "string" && uri.length > 0) return uri;
    const id = result?.id ?? result?.playlist?.id;
    if (typeof id === "string" && id.length > 0) return `spotify:playlist:${id}`;
    throw new Error("Spotify did not return a playlist URI");
}

export function makePlaylistPrivate(playlistUri: string) {
    // Spotify can reject this permission update independently from creating a
    // playlist. Keep that failure from becoming an unhandled rejection or
    // preventing the rating itself from being saved.
    window.setTimeout(() => {
        void Spicetify.CosmosAsync.post(`sp://core-playlist/v1/playlist/${playlistUri}/set-base-permission`, {
            permission_level: "BLOCKED",
        }).catch((error) => console.warn("Could not make the rating playlist private:", error));
    }, 1000);
}

export async function createFolder(name: string) {
    await getRootlistAPI(["createFolder"]).createFolder(name, { before: "" });
}

function getAlbumTrackItems(album: any): any[] {
    if (Array.isArray(album?.tracks?.items)) return album.tracks.items;
    if (Array.isArray(album?.tracks)) return album.tracks;
    if (Array.isArray(album?.items)) return album.items;

    // Spotify's in-client album endpoint (the endpoint recommended in the
    // current Spicetify documentation) groups tracks by disc.
    if (Array.isArray(album?.discs)) {
        return album.discs.flatMap((disc: any) => (Array.isArray(disc?.tracks) ? disc.tracks : []));
    }

    return [];
}

function withAlbumTracks(album: any): any {
    const items = getAlbumTrackItems(album);
    return {
        ...album,
        tracks: {
            ...(album?.tracks && !Array.isArray(album.tracks) ? album.tracks : {}),
            items,
            total: typeof album?.tracks?.total === "number" ? album.tracks.total : items.length,
            offset: 0,
            limit: items.length,
            next: null,
        },
    };
}

export async function getAlbum(uri: string) {
    const albumId = uri.replace(/^spotify:album:/, "");
    if (!albumId || albumId === uri) throw new Error("Invalid Spotify album URI");

    // Keep this helper on the public Web API. Album page ratings deliberately
    // do not call it: current Spotify clients can reject internal album
    // requests while the route is mounting.
    const albumUrl = `https://api.spotify.com/v1/albums/${albumId}`;
    const tracksUrl = `${albumUrl}/tracks`;
    const limit = 50;
    const album = await Spicetify.CosmosAsync.get(albumUrl);
    const normalizedAlbum = withAlbumTracks(album);
    const items = [...normalizedAlbum.tracks.items];
    const total = normalizedAlbum.tracks.total;
    let offset = items.length;

    // Fetch remaining pages for very long albums.
    while (offset < total) {
        const page = await Spicetify.CosmosAsync.get(`${tracksUrl}?offset=${offset}&limit=${limit}`);
        const pageItems = getAlbumTrackItems(page);
        if (pageItems.length === 0) break;

        items.push(...pageItems);
        offset += pageItems.length;
    }

    normalizedAlbum.tracks = { ...normalizedAlbum.tracks, items, total, offset: 0, limit: items.length, next: null };
    return normalizedAlbum;
}

export async function getContents() {
    const contents = await getRootlistAPI(["getContents"]).getContents();
    if (!contents || !Array.isArray(contents.items)) throw new Error("Spotify returned invalid library contents");
    return contents;
}

export async function addTrackToLikedSongs(trackUri: string) {
    // check if track is already liked
    const isLiked = await getLibraryAPI(["contains"]).contains(trackUri);
    if (isLiked[0]) {
        return;
    }

    // false refers to whether to silently add to liked songs (no notification)
    await getLibraryAPI(["add"]).add({ uris: [trackUri], silent: 0 });
}

export async function removeTrackFromLikedSongs(trackUri: string) {
    // false refers to whether to silently add to liked songs (no notification)
    await getLibraryAPI(["remove"]).remove({ uris: [trackUri], silent: 0 });
}

export async function addTrackToPlaylist(playlistUri: string, trackUri: string) {
    await getPlaylistAPI(["add"]).add(playlistUri, [trackUri], { after: 1, before: 0 });
}

export async function removeTrackFromPlaylist(playlistUri: string, trackUri: string, playlistItemId: string) {
    if (!playlistItemId) throw new Error("Cannot remove a rating without a playlist-item ID");
    await getPlaylistAPI(["remove"]).remove(playlistUri, [{ uri: trackUri, uid: playlistItemId }]);
}

export async function getPlaylistItems(uri: string): Promise<Track[]> {
    const result = await getPlaylistAPI(["getContents"]).getContents(uri);
    if (!result || !Array.isArray(result.items)) throw new Error("Spotify returned invalid playlist contents");
    return result.items as Track[];
}

export async function isAppLaterThan(specifiedVersion: string) {
    const version = Spicetify.Platform.version ?? (await Spicetify.CosmosAsync.get("sp://desktop/v1/version"))?.version;
    return typeof version === "string" && version.localeCompare(specifiedVersion, undefined, { numeric: true, sensitivity: "base" }) > 0;
}

export async function moveTracksBefore(playlistUri: string, trackUids: string[], beforeUid: string) {
    const isV2 = await isAppLaterThan("1.2.5.1006.g22820f93");
    await getPlaylistAPI(["move"]).move(
        playlistUri,
        trackUids.map((uid) => ({ uid: uid })),
        { before: isV2 ? { uid: beforeUid } : beforeUid },
    );
}

export async function moveTracksAfter(playlistUri: string, trackUids: string[], afterUid: string) {
    const isV2 = await isAppLaterThan("1.2.5.1006.g22820f93");
    await getPlaylistAPI(["move"]).move(
        playlistUri,
        trackUids.map((uid) => ({ uid: uid })),
        { after: isV2 ? { uid: afterUid } : afterUid },
    );
}

export interface IsrcMatch {
    uri: string;
    name: string;
    artists: Array<{ name: string }>;
}

const isrcMatchCache = new Map<string, { matches: IsrcMatch[]; expiresAt: number }>();
const ISRC_CACHE_TTL_MS = 10 * 60 * 1000;
const ISRC_CACHE_MAX_ENTRIES = 100;

export async function getTracksWithSameISRC(uri: string): Promise<IsrcMatch[]> {
    const trackId = uri.startsWith("spotify:track:") ? uri.slice("spotify:track:".length) : uri;
    if (!trackId || trackId.includes(":")) return [];

    const cached = isrcMatchCache.get(trackId);
    if (cached && cached.expiresAt > Date.now()) return cached.matches;

    const track = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`);
    const isrc = track?.external_ids?.isrc;
    if (typeof isrc !== "string" || !isrc.trim()) return [];

    // Search parameters belong in the URL; CosmosAsync's second GET argument
    // is a request body and Spotify's Web API does not read it as query data.
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.search = new URLSearchParams({ q: `isrc:${isrc.trim()}`, type: "track", limit: "50" }).toString();
    const response = await Spicetify.CosmosAsync.get(searchUrl.toString());
    const matches: IsrcMatch[] = Array.isArray(response?.tracks?.items)
        ? response.tracks.items.flatMap((item: any) => {
              if (typeof item?.uri !== "string" || !item.uri.startsWith("spotify:track:")) return [];
              return [
                  {
                      uri: item.uri,
                      name: typeof item.name === "string" ? item.name : "Unknown track",
                      artists: Array.isArray(item.artists)
                          ? item.artists.flatMap((artist: any) => (typeof artist?.name === "string" ? [{ name: artist.name }] : []))
                          : [],
                  },
              ];
          })
        : [];
    const uniqueMatches = Array.from(new Map(matches.map((match) => [match.uri, match])).values());

    isrcMatchCache.set(trackId, { matches: uniqueMatches, expiresAt: Date.now() + ISRC_CACHE_TTL_MS });
    if (isrcMatchCache.size > ISRC_CACHE_MAX_ENTRIES) {
        const oldestTrackId = isrcMatchCache.keys().next().value;
        if (oldestTrackId) isrcMatchCache.delete(oldestTrackId);
    }
    return uniqueMatches;
}

export async function getLikedSongsTracks(): Promise<Array<{ uri: string; link: string }>> {
    // LibraryAPI may not exist, but using the official API causes ratelimit hits
    const res = await getLibraryAPI(["getTracks"]).getTracks({ limit: -1 }); // this seems to get all tracks (at least >1300)
    const array = res?.items ?? [];

    return array.map((item: any) => ({ uri: item.uri, link: item.uri }));
}

export async function getPlaylistMetadata(playlistUri: string) {
    // try platformAPI first, fall back to api.spotify.com
    let platformMetadata;
    try {
        platformMetadata = await getPlaylistAPI(["getMetadata"]).getMetadata(playlistUri);
    } catch {
        // Fall back to the public Web API when this client has no metadata helper.
    }
    if (platformMetadata) return platformMetadata;

    const playlistId = playlistUri.split(":").pop();
    return await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/playlists/${playlistId}`);
}

export async function addTracksToPlaylist(playlistUri: string, trackUris: string[]) {
    await getPlaylistAPI(["add"]).add(playlistUri, trackUris, { before: 1, after: 0 });
}

export async function moveToFront(playlistUri: string, uid: string) {
    await getPlaylistAPI(["move"]).move(playlistUri, [{ uid: uid }], { insert_before: 0 });
}

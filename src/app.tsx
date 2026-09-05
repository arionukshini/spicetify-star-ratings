import * as api from "./api";
import { getCachedAlbumRating, saveCachedAlbumRating } from "./album-rating-cache";
import { createStars, setRating, getMouseoverRating, findStars, toRatingString } from "./stars";
import { Settings, getSettings, saveSettings, getPlaylistUris, savePlaylistUris, getRatedFolderUri, saveRatedFolderUri } from "./settings";
import { Settings as SettingsUi } from "./settings-ui";
import { SortModal } from "./sort-modal";
import { WeightedPlaylistModal } from "./weighted-playlist-modal";
import { RatingPlaylistModal } from "./rating-playlist-modal";
import {
    findFolderByName,
    findFolderByUri,
    getAllPlaylistItems,
    getRatingsByTrack,
    mergeAddedTrack,
    getPlaylistNames,
    getPlaylistItemId,
    sortPlaylistByRating,
    parseRatingPlaylistName,
    getCanonicalRating,
} from "./ratings";
import { PlaylistUris, Ratings, TimestampedRating, Track } from "./types/store";
import { tracklistColumnCss } from "./css/css";
import {
    getTracklistTrackUri,
    isAlbumPage,
    trackUriToTrackId,
    getNowPlayingTrackUri,
    weightedPlaybackEnabledForPlaylist,
    setWeightedPlaybackEnabledForPlaylist,
    getPlayerContext,
} from "./utils/utils";

export let settings: Settings | null = null;

let ratedFolderUri: string | null = null;
let ratings: Ratings = {};
let playlistNames = {};
export let playlistUris: PlaylistUris = {};

let originalTracklistHeaderCss = null;
let originalTracklistTrackCss = null;
let mainElement: Element | null = null;
let mainElementObserver: MutationObserver | null = null;
let tracklists: HTMLCollectionOf<Element> = [];
let oldTracklists = [];

let nowPlayingWidget: Element | null = null;

let albumId: string | null = null;
let albumStarData = null;
let albumRatingSummary: HTMLSpanElement | null = null;
let albumRefreshGeneration = 0;
let nowPlayingWidgetStarData = null;

let ratingsLoading = false;
let isSorting = false;
let ratingChangeQueue: Promise<void> = Promise.resolve();
let tracklistUpdateScheduled = false;
let observerCallbackScheduled = false;
let weightedQueueUpdateInFlight = false;
let weightedShuffleButton: HTMLButtonElement | null = null;

export function getTrackRating(trackUri: string): number | null {
    return getCanonicalRating(ratings, trackUri);
}

export function getTrackRatingOrDefault(trackUri: string): number {
    return getTrackRating(trackUri) ?? parseFloat(settings.defaultRating);
}

// --- weighted playback ---

function getTrackWeight(trackUri: string): number {
    const rating = getTrackRatingOrDefault(trackUri);
    switch (settings.ratingToWeight.kind) {
        case "Linear":
            return rating;
        case "Exponential":
            return Math.pow(settings.ratingToWeight.base, rating);

        // Make the switch exhaustive at compile time
        default: {
            const _exhaustive: never = settings.ratingToWeight;
            return _exhaustive;
        }
    }
}

function selectWeightedRandomTrack(): Promise<string | null> {
    return new Promise(async (resolve) => {
        try {
            const currentContext = getPlayerContext();

            if (!currentContext || !currentContext.uri) {
                resolve(null);
                return;
            }

            let availableTracks = [];

            if (currentContext.uri.includes("playlist")) {
                // Get tracks from current playlist
                const playlistUri = currentContext.uri;
                availableTracks = await api.getPlaylistItems(playlistUri);
            } else if (currentContext.uri.includes("album")) {
                // Get tracks from current album
                const albumId = currentContext.uri.split(":").pop();
                const album = await api.getAlbum(albumId);
                availableTracks = album.tracks.items.map((track) => ({
                    uri: track.uri,
                    link: track.uri,
                }));
            } else if (currentContext.uri.includes("collection")) {
                availableTracks = await api.getLikedSongsTracks();
            } else {
                resolve(null);
                return;
            }

            const availableTrackLinks = availableTracks.map((track) => track.link ?? track.uri);

            if (availableTrackLinks.length === 0) {
                resolve(null);
                return;
            }

            // Filter out tracks that are already in queue or currently playing
            const currentTrackUri = Spicetify.Player.data.item?.uri;
            const queuedTracks = getQueuedTracks();

            const eligibleTracks = availableTrackLinks.filter(
                (track) => track !== currentTrackUri && !queuedTracks.some((queued) => queued.uri === track),
            );

            if (eligibleTracks.length === 0) {
                resolve(null);
                return;
            }

            // Calculate weights and perform weighted random selection
            const weights = eligibleTracks.map((track) => getTrackWeight(track));
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

            if (totalWeight <= 0) {
                resolve(null);
                return;
            }

            let randomValue = Math.random() * totalWeight;
            for (let i = 0; i < eligibleTracks.length; i++) {
                randomValue -= weights[i];
                if (randomValue <= 0) {
                    resolve(eligibleTracks[i]);
                    return;
                }
            }

            resolve(eligibleTracks[eligibleTracks.length - 1]);
        } catch (error) {
            console.error("Error in weighted track selection:", error);
            resolve(null);
        }
    });
}

function getQueuedTracks(): Array<{ uri: string }> {
    try {
        return Spicetify.Queue.nextTracks
            .filter((track) => track.provider === "queue")
            .map((track) => ({
                uri: track.contextTrack.uri,
            }));
    } catch (e) {
        console.log("Failed to get queued tracks:", e);
        return [];
    }
}

async function addWeightedTrackToQueue(): Promise<boolean> {
    if (!weightedPlaybackEnabledForPlaylist()) return false;

    try {
        const trackUri = await selectWeightedRandomTrack();
        if (!trackUri) return false;

        await Spicetify.addToQueue([{ uri: trackUri }]);

        // ensure track was actually enqueued, work-around for an issue with remote play
        if (settings.reEnqueueWorkaround) {
            await new Promise((r) => setTimeout(r, 1000)); // anything significantly shorter than 1s doesn't seem to work
            if (
                !getQueuedTracks()
                    .map((track) => track.uri)
                    .includes(trackUri)
            ) {
                console.log("Re-enqueueing after 1s:", trackUri);
                await Spicetify.addToQueue([{ uri: trackUri }]);
            }
        }

        return true;
    } catch (error) {
        console.error("Error adding weighted track to queue:", error);
        return false;
    }
}

function shouldAddWeightedTrack(): boolean {
    // Only add weighted tracks if there's no existing queue
    return getQueuedTracks().length == 0;
}

function requestWeightedQueueUpdate() {
    if (weightedQueueUpdateInFlight) return;

    weightedQueueUpdateInFlight = true;
    void (async () => {
        try {
            if (weightedPlaybackEnabledForPlaylist() && shouldAddWeightedTrack()) {
                await addWeightedTrackToQueue();
            }
        } catch (error) {
            console.error("Error updating weighted queue:", error);
        } finally {
            weightedQueueUpdateInFlight = false;
        }
    })();
}

// --- weighted playlist ---

async function createWeightedShufflePlaylist(originalPlaylistUri: string, trackCount: number): Promise<any> {
    try {
        // Get the original playlist name
        const originalPlaylist = await api.getPlaylistMetadata(originalPlaylistUri);
        const originalName = originalPlaylist.name;
        const weightedName = `${originalName} (Weighted ${trackCount})`;

        // Create the new weighted shuffle playlist
        let weightedPlaylist;
        try {
            weightedPlaylist = await api.createPlaylist(weightedName, "");
        } catch (error) {
            // If playlist already exists, try with a suffix
            let suffix = 1;
            while (suffix <= 100) {
                try {
                    weightedPlaylist = await api.createPlaylist(`${weightedName} (${suffix})`, "");
                    break;
                } catch (e) {
                    suffix++;
                }
            }
            if (!weightedPlaylist) {
                throw new Error("Unable to create weighted playlist");
            }
        }

        // Get all tracks from the original playlist
        const tracks = await api.getPlaylistItems(originalPlaylistUri);
        if (tracks.length === 0) return weightedPlaylist;

        // Calculate weights for all tracks
        const tracksWithWeights = tracks.map((track) => ({
            uri: track.link ?? track.uri,
            weight: getTrackWeight(track.link ?? track.uri),
        }));

        // Filter out tracks with zero weight (unlikely but possible)
        const validTracks = tracksWithWeights.filter((track) => track.weight > 0);

        if (validTracks.length === 0) {
            throw new Error("No tracks with valid weights found");
        }

        // Select tracks using weighted random selection (same logic as queue)
        const selectedTracks = selectWeightedTracks(validTracks, trackCount);

        if (selectedTracks.length === 0) {
            throw new Error("No tracks could be selected");
        }

        // Add tracks to the weighted playlist in batches
        const batchSize = 50; // Spotify API limit
        for (let i = 0; i < selectedTracks.length; i += batchSize) {
            const batch = selectedTracks.slice(i, i + batchSize);
            const trackUris = batch.map((track) => track.uri);
            await api.addTracksToPlaylist(weightedPlaylist, trackUris);
        }

        return weightedPlaylist;
    } catch (error) {
        console.error("Error creating weighted playlist:", error);
        return null;
    }
}

function selectWeightedTracks(tracks: Array<{ uri: string; weight: number }>, count: number): Array<{ uri: string; weight: number }> {
    const selected: Array<{ uri: string; weight: number }> = [];

    for (let i = 0; i < count; i++) {
        // Calculate total weight of remaining tracks
        const totalWeight = tracks.reduce((sum, track) => sum + track.weight, 0);

        if (totalWeight <= 0) break;

        // Select a random value
        let randomValue = Math.random() * totalWeight;

        // Find the track that corresponds to this random value
        for (const track of tracks) {
            randomValue -= track.weight;
            if (randomValue <= 0) {
                selected.push(track);
                break;
            }
        }
    }

    return selected;
}

function findAlbumHeader(): Element | null {
    // Spotify 1.2.98 renders the album heading in this stable semantic
    // container. It contains the "Album" pretitle, title, and metadata.
    const albumPage = document.querySelector("[data-testid='album-page']");
    return (
        albumPage?.querySelector(".main-entityHeader-headerText") ??
        document.querySelector("main .main-entityHeader-headerText")
    );
}

function ensureAlbumStars(): boolean {
    if (!isAlbumPage()) {
        if (albumStarData) albumStarData[0].style.display = "none";
        return false;
    }

    const header = findAlbumHeader();
    if (!header) return false;

    if (!albumStarData || !albumStarData[0].isConnected) {
        albumStarData?.[0].remove();
        albumStarData = createStars("album-header", 22);
        albumStarData[0].classList.add("starRatingsAlbumHeader");
        albumStarData[0].dataset.starRatingsAlbumRating = "true";
        albumStarData[0].setAttribute("role", "img");
        albumStarData[0].setAttribute("aria-label", "Album rating");
        albumStarData[0].style.gap = "2px";
        albumStarData[0].style.marginTop = "8px";
        albumStarData[0].style.marginBottom = "4px";
        albumStarData[0].style.minHeight = "22px";
        albumStarData[0].style.width = "fit-content";
        albumStarData[0].style.alignItems = "center";

        // Album ratings are important context, so show a numeric average in
        // addition to the star fill even when track-row exact ratings are off.
        albumRatingSummary = document.createElement("span");
        albumRatingSummary.className = "starRatingsAlbumSummary";
        albumRatingSummary.style.marginLeft = "8px";
        albumRatingSummary.style.fontSize = "0.875rem";
        albumRatingSummary.style.fontWeight = "700";
        albumRatingSummary.style.opacity = "0.9";
        albumRatingSummary.style.whiteSpace = "nowrap";
        albumStarData[0].appendChild(albumRatingSummary);
    }

    // Put the rating between the title and album metadata. This avoids the
    // unstable action-bar classes that Spotify recently removed.
    const metadata = header.querySelector(".main-entityHeader-metaData");
    if (metadata) {
        if (albumStarData[0].parentElement !== header || albumStarData[0].nextElementSibling !== metadata) {
            metadata.insertAdjacentElement("beforebegin", albumStarData[0]);
        }
    } else if (albumStarData[0].parentElement !== header) {
        header.appendChild(albumStarData[0]);
    }

    return true;
}

function getRenderedAlbumRatingDetails() {
    const albumPage = document.querySelector("[data-testid='album-page']");
    const trackUris = new Set<string>();
    const trackRows = albumPage?.querySelectorAll(".main-trackList-trackListRow") ?? [];

    for (const trackRow of Array.from(trackRows)) {
        const trackUri = getTracklistTrackUri(trackRow);
        if (typeof trackUri === "string" && trackUri.includes("track")) {
            trackUris.add(trackUri);
        }
    }

    let sumRatings = 0;
    let ratedTracks = 0;
    for (const trackUri of trackUris) {
        if (!ratings[trackUri]?.length) continue;
        const rating = getCanonicalRating(ratings, trackUri);
        if (rating === null || !Number.isFinite(rating)) continue;

        sumRatings += rating;
        ratedTracks += 1;
    }

    return {
        average: ratedTracks > 0 ? Math.round((sumRatings / ratedTracks) * 4) / 4 : null,
        ratedTracks,
        totalTracks: trackUris.size,
    };
}

function updateAlbumRating() {
    if (!albumStarData) return;

    const renderedDetails = getRenderedAlbumRatingDetails();
    // Use the exact track rows Spotify has already rendered. This is the same
    // source as the visible Ratings column and avoids making an album request
    // while Spotify itself is still loading the album page.
    const calculatedDetails = renderedDetails;
    const cachedDetails = getCachedAlbumRating(albumId);
    const { average, ratedTracks, totalTracks } = calculatedDetails.ratedTracks > 0 ? calculatedDetails : cachedDetails ?? calculatedDetails;
    const stars = albumStarData[0];
    const hasRating = average !== null;

    stars.style.display = hasRating && albumId ? "flex" : "none";
    if (!hasRating) {
        if (albumRatingSummary) albumRatingSummary.textContent = "";
        stars.removeAttribute("title");
        stars.setAttribute("aria-label", "Album has no rated tracks");
        return;
    }

    // An album mean is meaningful at quarter-star precision. Preserve that
    // visual precision even if song-rating input is set to half stars.
    setRating(albumStarData[1], average, albumStarData[2], { forceQuarterStars: true });
    const exactAverage = average.toFixed(2);
    const countLabel = totalTracks > 0 ? `${ratedTracks}/${totalTracks} rated` : `${ratedTracks} rated`;
    if (albumRatingSummary) {
        albumRatingSummary.textContent = albumStarData[2] ? `· ${countLabel}` : `${exactAverage}/5 · ${countLabel}`;
    }
    stars.title = `Album rating: ${exactAverage}/5 (${ratedTracks} of ${totalTracks} tracks rated)`;
    stars.setAttribute("aria-label", stars.title);

    // Keep a small local cache so a previously calculated album average is
    // available immediately on the next visit. A fresh calculation always
    // replaces it once Spotify's album data or visible rows are ready.
    if (calculatedDetails.ratedTracks > 0) {
        saveCachedAlbumRating(albumId, calculatedDetails as { average: number; ratedTracks: number; totalTracks: number });
    }
}

async function findFreshPlaylistItemId(playlistUri: string, trackUri: string, ratedAt?: Date): Promise<string | null> {
    const playlistItems = (await api.getPlaylistItems(playlistUri)) as Track[];
    const candidates: Array<{ id: string; addedAt: number }> = playlistItems
        .filter((item) => (item.link ?? item.uri) === trackUri)
        .map((item) => ({ id: getPlaylistItemId(item), addedAt: new Date(item.addedAt).getTime() }))
        .filter((item): item is { id: string; addedAt: number } => item.id !== null);

    if (candidates.length === 0) return null;
    if (!ratedAt) return candidates[candidates.length - 1].id;

    return candidates.reduce((closest, candidate) =>
        Math.abs(candidate.addedAt - ratedAt.getTime()) < Math.abs(closest.addedAt - ratedAt.getTime()) ? candidate : closest,
    ).id;
}

async function handleRemoveRating(trackUri: string, rating: number, uid?: string, showNotification = true) {
    const entry =
        uid != null ? ratings[trackUri]?.find((r) => r.rating === rating && r.uid === uid) : ratings[trackUri]?.find((r) => r.rating === rating);
    const targetPlaylistUri = entry?.playlistUri ?? (playlistUris[rating] ?? [])[0];
    if (!targetPlaylistUri) throw new Error(`Could not find the ${toRatingString(rating)} rating playlist`);
    const playlistItemId = entry?.uid ?? uid;
    if (!playlistItemId) throw new Error("Could not find this rating's playlist-item ID. Reload ratings and try again.");

    const playlistName = playlistNames[targetPlaylistUri] ?? toRatingString(rating);
    try {
        await api.removeTrackFromPlaylist(targetPlaylistUri, trackUri, playlistItemId);
    } catch (error) {
        // Playlist rows can be re-keyed after an external edit or a Spotify
        // client update. Re-fetch once and retry with the current row ID.
        const freshPlaylistItemId = await findFreshPlaylistItemId(targetPlaylistUri, trackUri, entry?.time);
        if (!freshPlaylistItemId || freshPlaylistItemId === playlistItemId) throw error;
        await api.removeTrackFromPlaylist(targetPlaylistUri, trackUri, freshPlaylistItemId);
    }

    if (entry) {
        const index = ratings[trackUri].findIndex((r) => r.rating === entry.rating && r.uid === entry.uid);
        if (index !== -1) {
            ratings[trackUri].splice(index, 1);
        }
        if (ratings[trackUri].length === 0) {
            delete ratings[trackUri];
        }
    } else if (uid == null) {
        delete ratings[trackUri];
    }

    if (showNotification) api.showNotification(`Removed from ${playlistName}`);
}

async function handleAddRating(trackUri: string, newRating: number, showNotification = true): Promise<boolean> {
    try {
        const contents = await api.getContents(); // get fresh contents

        let ratedFolder = ratedFolderUri
            ? (findFolderByUri(contents, ratedFolderUri) ?? findFolderByName(contents, "Rated"))
            : findFolderByName(contents, "Rated");

        if (!ratedFolder) {
            await api.createFolder("Rated");
            const contents = await api.getContents();
            ratedFolder = findFolderByName(contents, "Rated");
            if (!ratedFolder) throw new Error("Could not find Rated folder after creating it");
            ratedFolderUri = ratedFolder.uri as string;
            saveRatedFolderUri(ratedFolderUri);
        } else if (!ratedFolderUri) {
            ratedFolderUri = ratedFolder.uri as string;
            saveRatedFolderUri(ratedFolderUri);
        }

        const ratingName = toRatingString(newRating);
        const urisForRating = playlistUris[newRating] ?? [];
        let targetPlaylistUri = urisForRating.length > 0 ? urisForRating[urisForRating.length - 1] : null;

        if (!targetPlaylistUri) {
            targetPlaylistUri = await api.createPlaylist(ratingName, ratedFolderUri);
            await api.makePlaylistPrivate(targetPlaylistUri);
            playlistUris[newRating] = [targetPlaylistUri];
            savePlaylistUris();
            playlistNames[targetPlaylistUri] = ratingName;
        } else {
            const items = await api.getPlaylistItems(targetPlaylistUri);
            if (items.length >= settings.maxPlaylistItems) {
                // next spillover
                const newPlaylistName = `${ratingName}(${urisForRating.length})`;
                targetPlaylistUri = await api.createPlaylist(newPlaylistName, ratedFolderUri);
                await api.makePlaylistPrivate(targetPlaylistUri);
                playlistUris[newRating] = [...urisForRating, targetPlaylistUri];
                savePlaylistUris();
                playlistNames[targetPlaylistUri] = newPlaylistName;
            }
        }

        // Both branches above guarantee a non-null target; assert for the type system
        if (!targetPlaylistUri) throw new Error("Could not determine target playlist");

        await api.addTrackToPlaylist(targetPlaylistUri, trackUri);

        const targetPlaylistItems = await api.getPlaylistItems(targetPlaylistUri);
        const addedEntry = mergeAddedTrack(ratings, targetPlaylistUri, newRating, trackUri, targetPlaylistItems);

        // Move the new rating entry to the front or back
        if (addedEntry) {
            if (settings.newRatingPosition === "front") {
                await api.moveToFront(targetPlaylistUri, addedEntry.uid);
            } else {
                const lastItem = targetPlaylistItems[targetPlaylistItems.length - 1];
                const lastItemUid = lastItem ? getPlaylistItemId(lastItem) : null;
                if (lastItemUid && addedEntry.uid !== lastItemUid) {
                    await api.moveTracksAfter(targetPlaylistUri, [addedEntry.uid], lastItemUid);
                }
            }
        } else {
            console.warn(`Could not find ${trackUri} in ${targetPlaylistUri} after adding it; ratings may be stale`);
        }

        if (showNotification) api.showNotification(`Added to ${playlistNames[targetPlaylistUri] ?? ratingName}`);
        return true;
    } catch (error) {
        console.error("Error in handleAddRating:", error);
        api.showNotification("Error updating rating: " + ((error as any).message || "Unknown error"));
        return false;
    }
}

function enqueueRatingChange(operation: () => Promise<void>) {
    // Playlist mutations change the local rating map as they finish. Keeping
    // them in one queue prevents quick clicks and duplicate-track work from
    // observing an older version of that map.
    const queuedOperation = ratingChangeQueue.catch(() => undefined).then(operation);
    ratingChangeQueue = queuedOperation.catch((error) => {
        console.error("Queued rating update failed:", error);
    });
    return queuedOperation;
}

async function getRatingTargetTrackUris(trackUri: string): Promise<string[]> {
    if (!settings.syncDuplicateSongs) return [trackUri];

    try {
        const tracksWithSameISRC = await api.getTracksWithSameISRC(trackUri.substring("spotify:track:".length));
        const trackUris = new Set([trackUri]);

        for (const track of tracksWithSameISRC) {
            const duplicateUri = track?.uri;
            // Keep an existing duplicate's individual rating intact. This is
            // the behavior advertised by the setting and avoids overwriting
            // ratings made before duplicate sync was enabled.
            if (typeof duplicateUri === "string" && !ratings[duplicateUri]?.length) {
                trackUris.add(duplicateUri);
            }
        }

        return [...trackUris];
    } catch (error) {
        console.error("Could not find duplicate tracks to sync:", error);
        api.showNotification("Rated this track, but could not sync duplicate tracks.");
        return [trackUri];
    }
}

async function applyRatingToTrack(trackUri: string, newRating: number, showNotification: boolean) {
    const oldRatings = ratings[trackUri];
    const fiveMinutes = 5 * 60 * 1000;
    const oldRating = settings.averageRatings ? oldRatings?.find((entry) => Date.now() - entry.time.getTime() <= fiveMinutes) : oldRatings?.[0];

    if (oldRating) {
        await handleRemoveRating(trackUri, oldRating.rating, oldRating.uid, showNotification);
    }

    if (!oldRating || oldRating.rating !== newRating) {
        const didAddRating = await handleAddRating(trackUri, newRating, showNotification);
        if (didAddRating && settings.likeThreshold !== "disabled" && newRating >= parseFloat(settings.likeThreshold)) {
            void api.addTrackToLikedSongs(trackUri).catch((error) => console.error("Could not add rated track to Liked Songs:", error));
        }
    }
}

function refreshTrackRatingUi(trackUri: string) {
    const tracklistStarData = findStars(trackUriToTrackId(trackUri));
    if (!tracklistStarData) return;

    const currentRating = getTrackRating(trackUri);
    setRating(tracklistStarData[1], currentRating, tracklistStarData[2]);
    tracklistStarData[0].style.visibility = currentRating === null ? "hidden" : "visible";
}

async function applyRatingChange(trackUri: string, newRating: number) {
    const targetTrackUris = await getRatingTargetTrackUris(trackUri);

    for (const targetTrackUri of targetTrackUris) {
        try {
            await applyRatingToTrack(targetTrackUri, newRating, targetTrackUri === trackUri);
        } catch (error) {
            console.error(`Could not update rating for ${targetTrackUri}:`, error);
            api.showNotification("Error updating rating: " + ((error as any).message || "Unknown error"));
        }
    }

    for (const targetTrackUri of targetTrackUris) refreshTrackRatingUi(targetTrackUri);
    updateNowPlayingWidget();
    const syncedDuplicateCount = targetTrackUris.length - 1;
    if (syncedDuplicateCount > 0) {
        api.showNotification(`Also rated ${syncedDuplicateCount} matching release${syncedDuplicateCount === 1 ? "" : "s"}.`);
    }
    // The album average is derived from the in-memory ratings map, so refresh
    // it only after the complete, serialised rating batch has finished.
    scheduleAlbumStars();
}

function getClickListener(i, ratingOverride, starData, getTrackUri) {
    return () => {
        if (ratingsLoading || isSorting || !starData) return;

        const star = starData[1]?.[i]?.[0];
        const trackUri: string = getTrackUri();
        if (typeof trackUri !== "string" || !star) return;

        const newRating: number = typeof ratingOverride === "number" ? ratingOverride : getMouseoverRating(settings, star, i);
        if (!Number.isFinite(newRating)) return;

        void enqueueRatingChange(() => applyRatingChange(trackUri, newRating)).catch((error) => {
            console.error("Could not apply rating change:", error);
            api.showNotification("Error updating rating: " + ((error as any).message || "Unknown error"));
        });
    };
}

function getRegisterKeyboardShortcuts(keys) {
    return () => {
        for (const [rating, key] of Object.entries(keys)) {
            Spicetify.Keyboard.registerShortcut(
                {
                    key: key,
                    ctrl: true,
                    alt: true,
                },
                getClickListener(0, parseFloat(rating), nowPlayingWidgetStarData, getNowPlayingTrackUri),
            );
        }
    };
}

function getDeregisterKeyboardShortcuts(keys) {
    return () => {
        for (const key of Object.values(keys)) {
            Spicetify.Keyboard._deregisterShortcut({
                key: key,
                ctrl: true,
                alt: true,
            });
        }
    };
}

function addStarsListeners(starData, getTrackUri) {
    function getCurrentRating(trackUri: string) {
        return getTrackRating(trackUri) ?? 0.0;
    }

    const [stars, starElements, label] = starData;

    stars.addEventListener("mouseout", function () {
        setRating(starElements, getCurrentRating(getTrackUri()), label);
    });

    for (let i = 0; i < 5; i++) {
        const star = starElements[i][0];

        star.addEventListener("mousemove", function () {
            const rating = getMouseoverRating(settings, star, i);
            setRating(starElements, rating, label);
        });

        star.addEventListener("click", getClickListener(i, null, starData, getTrackUri));
    }
}

function restoreTracklist() {
    const tracklistHeaders = document.querySelectorAll(".main-trackList-trackListHeaderRow");
    tracklistHeaders.forEach((tracklistHeader) => {
        tracklistHeader.style["grid-template-columns"] = originalTracklistHeaderCss;
        const ratingHeader = tracklistHeader.querySelector(".starRatingsHeader");
        if (ratingHeader) {
            ratingHeader.remove();
            let lastColumn = tracklistHeader.querySelector(".main-trackList-rowSectionEnd");
            let colIndexInt = parseInt(lastColumn.getAttribute("aria-colindex"));
            lastColumn.setAttribute("aria-colindex", (colIndexInt - 1).toString());
        }
    });

    for (const tracklist of Array.from(tracklists)) {
        const tracks = tracklist.getElementsByClassName("main-trackList-trackListRow");
        for (const track of Array.from(tracks)) {
            let ratingColumn = track.querySelector(".starRatings");
            if (!ratingColumn) continue;
            track.style["grid-template-columns"] = originalTracklistTrackCss;
            ratingColumn.remove();
            let lastColumn = track.querySelector(".main-trackList-rowSectionEnd");
            let colIndexInt = parseInt(lastColumn.getAttribute("aria-colindex"));
            lastColumn.setAttribute("aria-colindex", (colIndexInt - 1).toString());
        }
    }
}

function updateTracklist() {
    // Check if showing playlist stars is enabled
    if (!settings.showPlaylistStars) return;

    // Store current tracklists as oldTracklists
    oldTracklists = tracklists;
    // Update tracklists
    tracklists = Array.from(document.querySelectorAll(".main-trackList-indexable"));
    // Check if tracklists have changed
    let tracklistsChanged = tracklists.length !== oldTracklists.length;

    // Check if individual tracklists have changed
    for (let i = 0; i < tracklists.length; i++) {
        if (!tracklists[i].isEqualNode(oldTracklists[i])) tracklistsChanged = true;
    }

    // Reset CSS if tracklists have changed
    if (tracklistsChanged) {
        originalTracklistHeaderCss = null;
        originalTracklistTrackCss = null;
    }

    // Define CSS for different tracklist columns

    createStarsForTracklists(tracklists);
}

function scheduleTracklistUpdate() {
    if (!settings?.showPlaylistStars || tracklistUpdateScheduled) return;

    tracklistUpdateScheduled = true;
    window.requestAnimationFrame(() => {
        tracklistUpdateScheduled = false;
        try {
            updateTracklist();
        } catch (error) {
            console.error("Error updating track ratings:", error);
        }
    });
}

function createStarsForTracklists(tracklists: HTMLCollectionOf<Element>) {
    // Store new tracklist header CSS
    let newTracklistHeaderCss = null;
    const tracklistHeaders = document.querySelectorAll(".main-trackList-trackListHeaderRow");
    // No tracklist header on Artist page
    tracklistHeaders.forEach((tracklistHeader) => {
        if (tracklistHeader.querySelector(".starRatingsHeader")) return; // already injected

        let lastColumn = tracklistHeader.querySelector(".main-trackList-rowSectionEnd");
        let colIndexInt = parseInt(lastColumn.getAttribute("aria-colindex"));

        // Set tracklist header CSS based on column index
        if (!originalTracklistHeaderCss) originalTracklistHeaderCss = getComputedStyle(tracklistHeader).gridTemplateColumns;
        if (originalTracklistHeaderCss && tracklistColumnCss[colIndexInt]) {
            tracklistHeader.style["grid-template-columns"] = tracklistColumnCss[colIndexInt];
            newTracklistHeaderCss = tracklistColumnCss[colIndexInt];
        }

        // Inject a header cell at the same column position as the stars cells in track rows
        lastColumn.setAttribute("aria-colindex", (colIndexInt + 1).toString());
        const ratingHeader = document.createElement("div");
        ratingHeader.setAttribute("aria-colindex", colIndexInt.toString());
        ratingHeader.role = "columnheader";
        ratingHeader.style.display = "flex";
        ratingHeader.style.alignItems = "center";
        ratingHeader.classList.add("main-trackList-rowSectionVariable");
        ratingHeader.classList.add("starRatingsHeader");
        const ratingHeaderLabel = document.createElement("span");
        ratingHeaderLabel.textContent = "Ratings";
        const existingLabel = tracklistHeader.querySelector("[role='columnheader'] span");
        if (existingLabel) {
            ratingHeaderLabel.className = existingLabel.className;
            for (const attr of Array.from(existingLabel.attributes)) {
                if (attr.name !== "class") ratingHeaderLabel.setAttribute(attr.name, attr.value);
            }
        }
        ratingHeader.appendChild(ratingHeaderLabel);
        tracklistHeader.insertBefore(ratingHeader, lastColumn);
    });

    // Iterate through each tracklist
    for (const tracklist of tracklists) {
        const tracks = tracklist.getElementsByClassName("main-trackList-trackListRow");
        // Iterate through each track
        for (const track of tracks) {
            // Function to get heart element of the track
            const getHeart = () => {
                return (
                    track.getElementsByClassName("main-addButton-button")[0] ??
                    track.querySelector(".main-trackList-rowHeartButton") ??
                    track.querySelector("button[class*='buttonTertiary-iconOnly']") ??
                    track.querySelector("button[aria-label='Add to playlist']")
                );
            };
            const hasStars = track.getElementsByClassName("stars").length > 0;
            const trackUri = getTracklistTrackUri(track);
            const isTrack = typeof trackUri === "string" && trackUri.includes("track");

            let ratingColumn = track.querySelector(".starRatings");
            // Add column for stars if not already present
            if (!ratingColumn) {
                let lastColumn = track.querySelector(".main-trackList-rowSectionEnd");
                let colIndexInt = parseInt(lastColumn.getAttribute("aria-colindex"));

                lastColumn.setAttribute("aria-colindex", (colIndexInt + 1).toString());
                ratingColumn = document.createElement("div");
                ratingColumn.setAttribute("aria-colindex", colIndexInt.toString());
                ratingColumn.role = "gridcell";
                ratingColumn.style.display = "flex";
                ratingColumn.classList.add("main-trackList-rowSectionVariable");
                ratingColumn.classList.add("starRatings");
                track.insertBefore(ratingColumn, lastColumn);

                if (!originalTracklistTrackCss) originalTracklistTrackCss = getComputedStyle(track).gridTemplateColumns;
                if (tracklistColumnCss[colIndexInt])
                    track.style["grid-template-columns"] = newTracklistHeaderCss ? newTracklistHeaderCss : tracklistColumnCss[colIndexInt];
            }

            // Continue to the next track if no heart, no track URI, has stars already, or not a track
            if (!trackUri || hasStars || !isTrack) continue;

            // Create stars for the track and set its rating
            const starData = createStars(trackUriToTrackId(trackUri), 16);
            const stars = starData[0];
            const starElements = starData[1];
            const label = starData[2];
            const currentRating = getTrackRating(trackUri) ?? 0.0;

            // Append stars to rating column and set listeners
            ratingColumn.appendChild(stars);
            setRating(starElements, currentRating, label);
            addStarsListeners(
                starData,
                () => {
                    return trackUri;
                },
                getHeart,
            );

            // Set visibility of stars based on rating
            stars.style.visibility = typeof ratings[trackUri] !== "undefined" ? "visible" : "hidden";

            // Add listeners for hovering over a track in the tracklist
            track.addEventListener("mouseover", () => {
                stars.style.visibility = "visible";
            });

            track.addEventListener("mouseout", () => {
                stars.style.visibility = typeof ratings[trackUri] !== "undefined" ? "visible" : "hidden";
            });
        }
    }
}

function removeWeightedShuffleButton() {
    weightedShuffleButton?.remove();
    weightedShuffleButton = null;
}

function updateWeightedShuffleButton() {
    if (!weightedShuffleButton?.isConnected) return;

    const enabled = weightedPlaybackEnabledForPlaylist();
    weightedShuffleButton.style.backgroundColor = enabled ? "var(--background-press, #1db954)" : "transparent";
    weightedShuffleButton.style.borderColor = enabled ? "var(--background-press, #1db954)" : "var(--essential-subdued, #878787)";
    weightedShuffleButton.style.color = enabled ? "#1DB954" : "var(--text-subdued, #6a6a6a)";
    weightedShuffleButton.title = enabled ? "Disable Weighted Shuffle" : "Enable Weighted Shuffle";
}

function refreshWeightedShuffleButton() {
    if (!settings?.showWeightedShuffle) {
        removeWeightedShuffleButton();
        return;
    }

    const shuffleButton =
        document.querySelector('[data-testid="control-button-shuffle"]') || document.querySelector('button[aria-label*="Shuffle" i]');
    const shuffleButtonParent = shuffleButton?.parentElement;
    if (!shuffleButton || !shuffleButtonParent) {
        removeWeightedShuffleButton();
        return;
    }

    if (weightedShuffleButton && (!weightedShuffleButton.isConnected || weightedShuffleButton.parentElement !== shuffleButtonParent)) {
        removeWeightedShuffleButton();
    }

    if (!weightedShuffleButton) {
        // A stale button can be left behind by Spotify remounting its player
        // controls. Remove it rather than attaching a second listener.
        document.querySelectorAll(".weighted-shuffle-button").forEach((button) => button.remove());

        weightedShuffleButton = document.createElement("button");
        weightedShuffleButton.className = "weighted-shuffle-button";
        weightedShuffleButton.style.cssText = `
            margin-left: 8px;
            background: transparent;
            border: 0px solid white;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s ease;
            color: var(--text-subdued, #6a6a6a);
            font-size: 16px;
            font-weight: bold;
        `;
        weightedShuffleButton.textContent = "W";
        weightedShuffleButton.addEventListener("click", () => {
            const nextEnabled = !weightedPlaybackEnabledForPlaylist();
            setWeightedPlaybackEnabledForPlaylist(nextEnabled);
            updateWeightedShuffleButton();
            if (nextEnabled) requestWeightedQueueUpdate();
            api.showNotification(nextEnabled ? "Weighted shuffle enabled" : "Weighted shuffle disabled");
        });
        shuffleButtonParent.insertBefore(weightedShuffleButton, shuffleButton.nextSibling);
    }

    updateWeightedShuffleButton();
}

function scheduleObserverCallback(keys) {
    if (observerCallbackScheduled) return;

    observerCallbackScheduled = true;
    window.requestAnimationFrame(() => {
        observerCallbackScheduled = false;
        void observerCallback(keys);
    });
}

async function observerCallback(keys) {
    const nextMainElement = document.querySelector("main");
    if (nextMainElement !== mainElement) {
        mainElementObserver?.disconnect();
        mainElement = nextMainElement;

        if (mainElement) {
            scheduleTracklistUpdate();
            mainElementObserver?.observe(mainElement, {
                childList: true,
                subtree: true,
            });
        }
    }

    const selector =
        settings.nowPlayingStarsPosition === "left" ? ".main-nowPlayingWidget-nowPlaying .main-trackInfo-container" : ".main-nowPlayingBar-right div";
    const nextNowPlayingWidget = document.querySelector(selector);
    if (nextNowPlayingWidget !== nowPlayingWidget) {
        nowPlayingWidgetStarData?.[0]?.remove();
        nowPlayingWidget = nextNowPlayingWidget;

        if (nowPlayingWidget) {
            nowPlayingWidgetStarData = createStars("now-playing", 16);
            nowPlayingWidgetStarData[0].style.marginLeft = "8px";
            nowPlayingWidgetStarData[0].style.marginRight = "8px";
            if (settings.nowPlayingStarsPosition === "left") nowPlayingWidget.after(nowPlayingWidgetStarData[0]);
            else nowPlayingWidget.prepend(nowPlayingWidgetStarData[0]);
            addStarsListeners(nowPlayingWidgetStarData, getNowPlayingTrackUri);
            updateNowPlayingWidget();
            if (settings.enableKeyboardShortcuts) {
                getRegisterKeyboardShortcuts(keys)();
            }
        }
    }

    refreshWeightedShuffleButton();
}

function updateAlbumStars() {
    const nextAlbumId = isAlbumPage();
    const routeChanged = albumId !== nextAlbumId;
    albumId = nextAlbumId;

    if (!albumId) {
        if (albumStarData) albumStarData[0].style.display = "none";
        return;
    }

    if (routeChanged) {
        if (albumStarData) albumStarData[0].style.display = "none";
    }

    // The header is filled from the persistent cache right away and then from
    // the visible album rows as Spotify finishes rendering them.
    if (ensureAlbumStars()) updateAlbumRating();
}

function scheduleAlbumStars() {
    const generation = ++albumRefreshGeneration;
    // Spotify's History event fires before the new album header exists. A few
    // bounded retries are enough to catch its asynchronous render without
    // subscribing to our own SVG attribute mutations.
    for (const delay of [0, 120, 400, 1000, 2000, 3500]) {
        window.setTimeout(() => {
            if (generation === albumRefreshGeneration) void updateAlbumStars();
        }, delay);
    }
}

function updateNowPlayingWidget() {
    if (!nowPlayingWidgetStarData) return;

    const trackUri = Spicetify.Player.data.item.uri;
    const isTrack = trackUri.includes("track");

    nowPlayingWidgetStarData[0].style.display = isTrack ? "flex" : "none";

    const currentRating = getTrackRating(trackUri) ?? 0.0;
    setRating(nowPlayingWidgetStarData[1], currentRating, nowPlayingWidgetStarData[2]);
}

function shouldAddContextMenuOnFolders(uri) {
    let uriObj = Spicetify.URI.fromString(uri[0]);
    return uriObj.type === Spicetify.URI.Type.FOLDER;
}

function shouldAddContextMenuOnPlaylists(uri) {
    let uriObj = Spicetify.URI.fromString(uri[0]);
    switch (uriObj.type) {
        case Spicetify.URI.Type.PLAYLIST:
        case Spicetify.URI.Type.PLAYLIST_V2:
            return true;
    }
    return false;
}

async function loadRatings() {
    ratings = {};
    playlistNames = {};

    playlistUris = getPlaylistUris();

    // Scan the rated folder to:
    //   1. Resolve playlistNames (display names for notifications).
    //   2. Migrate users coming from the dynamic-scanning era (empty localStorage).
    const contents = await api.getContents();
    const ratedFolder = ratedFolderUri
        ? (findFolderByUri(contents, ratedFolderUri) ?? findFolderByName(contents, "Rated"))
        : findFolderByName(contents, "Rated");

    if (ratedFolder) {
        ratedFolderUri = ratedFolder.uri as string;

        // Auto-register any playlists in the rated folder that have a valid
        // rating name but are not yet registered in playlistUris.
        let changed = false;
        const allRegistered = new Set(Object.values(playlistUris).flat());
        for (const item of ratedFolder.items) {
            if (item.type !== "playlist") continue;
            if (allRegistered.has(item.uri)) continue;
            const parsed = parseRatingPlaylistName(item.name);
            if (!parsed) continue;
            const { rating, version } = parsed;
            if (!playlistUris[rating]) {
                playlistUris[rating] = [];
            }
            while (playlistUris[rating].length <= version) {
                playlistUris[rating].push(null as unknown as string);
            }
            playlistUris[rating][version] = item.uri;
            playlistUris[rating] = playlistUris[rating].filter(Boolean);
            allRegistered.add(item.uri);
            changed = true;
        }
        if (changed) {
            savePlaylistUris();
        }

        playlistNames = getPlaylistNames(playlistUris, ratedFolder);
    } else {
        ratedFolderUri = null;
    }

    const allPlaylistItems = await getAllPlaylistItems(playlistUris);
    ratings = getRatingsByTrack(allPlaylistItems);
}

async function main() {
    while (!Spicetify?.showNotification) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    settings = getSettings();
    saveSettings(settings);

    // Restore the previously-saved rated folder URI so loadRatings can find the right folder.
    ratedFolderUri = getRatedFolderUri();

    await loadRatings();

    const keys = {
        "5.0": Spicetify.Keyboard.KEYS.NUMPAD_0,
        "0.5": Spicetify.Keyboard.KEYS.NUMPAD_1,
        "1.0": Spicetify.Keyboard.KEYS.NUMPAD_2,
        "1.5": Spicetify.Keyboard.KEYS.NUMPAD_3,
        "2.0": Spicetify.Keyboard.KEYS.NUMPAD_4,
        "2.5": Spicetify.Keyboard.KEYS.NUMPAD_5,
        "3.0": Spicetify.Keyboard.KEYS.NUMPAD_6,
        "3.5": Spicetify.Keyboard.KEYS.NUMPAD_7,
        "4.0": Spicetify.Keyboard.KEYS.NUMPAD_8,
        "4.5": Spicetify.Keyboard.KEYS.NUMPAD_9,
    };

    const registerKeyboardShortcuts = getRegisterKeyboardShortcuts(keys);
    const deregisterKeyboardShortcuts = getDeregisterKeyboardShortcuts(keys);
    const redrawNowPlayingStars = () => {
        if (nowPlayingWidgetStarData) nowPlayingWidgetStarData[0].remove();
        nowPlayingWidget = null;
        observerCallback(keys);
    };

    new Spicetify.Menu.Item("Star Ratings", true, () => {
        Spicetify.PopupModal.display({
            title: "Star Ratings",
            content: SettingsUi({
                settings,
                registerKeyboardShortcuts,
                deregisterKeyboardShortcuts,
                updateTracklist: scheduleTracklistUpdate,
                restoreTracklist,
                redrawNowPlayingStars,
                refreshWeightedShuffleButton,
            }),
            isLarge: true,
        });
    }).register();

    mainElementObserver = new MutationObserver(() => {
        scheduleTracklistUpdate();
    });

    Spicetify.Player.addEventListener("songchange", () => {
        const trackUri = Spicetify.Player.data.item.uri;

        const skip =
            (trackUri in ratings && settings.play === "onlyunrated") ||
            (!(trackUri in ratings) && settings.play === "onlyrated") ||
            (settings.skipThreshold !== "disabled" && (getTrackRating(trackUri) ?? NaN) <= parseFloat(settings.skipThreshold));

        if (skip) {
            Spicetify.Player.next();
            return;
        }

        updateNowPlayingWidget();
        updateWeightedShuffleButton();
        requestWeightedQueueUpdate();
    });

    Spicetify.Platform.History.listen(() => {
        scheduleAlbumStars();
    });

    new Spicetify.ContextMenu.Item(
        "Use as Rated folder",
        (uri) => {
            ratedFolderUri = uri[0];
            saveRatedFolderUri(ratedFolderUri);
            ratingsLoading = true;
            loadRatings().finally(() => {
                ratingsLoading = false;
            });
        },
        shouldAddContextMenuOnFolders,
    ).register();

    new Spicetify.ContextMenu.Item(
        "Create weighted Playlist",
        (uri) => {
            const playlistUri = uri[0];
            Spicetify.PopupModal.display({
                title: "Create Weighted Playlist",
                content: Spicetify.React.createElement(WeightedPlaylistModal, {
                    onClickCancel: () => {
                        Spicetify.PopupModal.hide();
                    },
                    onClickCreate: async (trackCount) => {
                        Spicetify.PopupModal.hide();
                        api.showNotification("Creating weighted playlist...");

                        try {
                            const weightedPlaylist = await createWeightedShufflePlaylist(playlistUri, trackCount);
                            if (weightedPlaylist) {
                                api.showNotification(`Weighted Playlist created with ${trackCount} tracks!`);
                            } else {
                                api.showNotification("Failed to create weighted Playlist");
                            }
                        } catch (error) {
                            console.error("Error creating weighted Playlist:", error);
                            api.showNotification("Error creating weighted Playlist");
                        }
                    },
                }),
            });
        },
        shouldAddContextMenuOnPlaylists,
    ).register();

    new Spicetify.ContextMenu.Item(
        "Sort by rating",
        (uri) => {
            Spicetify.PopupModal.display({
                title: "Modify Custom order?",
                content: SortModal({
                    onClickCancel: () => {
                        Spicetify.PopupModal.hide();
                    },
                    onClickOK: () => {
                        Spicetify.PopupModal.hide();
                        isSorting = true;
                        api.showNotification("Sorting...");
                        sortPlaylistByRating(uri[0], ratings).finally(() => {
                            isSorting = false;
                        });
                    },
                }),
            });
        },
        shouldAddContextMenuOnPlaylists,
    ).register();

    new Spicetify.ContextMenu.Item(
        "Use as rating playlist",
        (uri) => {
            const playlistUri = uri[0];

            // Fetch folder contents fresh so we're always in-sync
            api.getContents().then((contents) => {
                const ratedFolder = ratedFolderUri
                    ? (findFolderByUri(contents, ratedFolderUri) ?? findFolderByName(contents, "Rated"))
                    : findFolderByName(contents, "Rated");

                const folderItem = ratedFolder?.items.find((item) => item.uri === playlistUri && item.type === "playlist");
                if (!folderItem) {
                    api.showNotification("This playlist is not inside the Rated folder.");
                    return;
                }

                const playlistName = folderItem.name;

                Spicetify.PopupModal.display({
                    title: "Use as rating playlist",
                    content: Spicetify.React.createElement(RatingPlaylistModal, {
                        playlistName,
                        currentPlaylistUris: playlistUris,
                        onClickCancel: () => {
                            Spicetify.PopupModal.hide();
                        },
                        onClickSave: (rating: number, version: number) => {
                            Spicetify.PopupModal.hide();

                            // Insert/replace the URI at the chosen version slot.
                            const existing = [...(playlistUris[rating] ?? [])];
                            // Expand the array if the version slot doesn't exist yet.
                            while (existing.length <= version) existing.push(null as unknown as string);
                            existing[version] = playlistUri;
                            // Remove any null gaps (keep only registered URIs).
                            playlistUris[rating] = existing.filter(Boolean);
                            savePlaylistUris();

                            // Also update the display name so notifications are correct.
                            playlistNames[playlistUri] = playlistName;

                            api.showNotification(`Registered "${playlistName}" as rating ${toRatingString(rating)} (position ${version}).`);

                            ratingsLoading = true;
                            loadRatings().finally(() => {
                                ratingsLoading = false;
                            });
                        },
                    }),
                });
            });
        },
        shouldAddContextMenuOnPlaylists,
    ).register();

    const observer = new MutationObserver(() => {
        scheduleObserverCallback(keys);
    });
    await observerCallback(keys);
    scheduleAlbumStars();
    requestWeightedQueueUpdate();
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

}

export default main;

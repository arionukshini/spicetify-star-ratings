export interface PlaylistUris {
    [key: number]: string[]; // rating -> playlist uris (last = latest)
}
export type TimestampedRating = { rating: number; time: Date; uid: string; playlistUri: string; };
export interface Ratings {
    [key: string]: TimestampedRating[];
}
export type Track = {
    // Spotify's playlist implementation has used both names across client
    // versions. These identify an item occurrence inside a playlist, not the
    // underlying track itself.
    uid?: string;
    rowId?: string;
    uri?: string;
    hasLyrics: boolean;
    link?: string;
    name: string;
    length: number;
    playable: boolean;
    isAvailableInMetadataCatalogue: boolean;
    locallyPlayable: boolean;
    playableLocalTrack: boolean;
    discNumber: number;
    trackNumber: number;
    isExplicit: boolean;
    is19PlusOnly: boolean;
    previewId: string;
    isLocal: boolean;
    isPremiumOnly: boolean;
    popularity: number;
    inCollection: boolean;
    canAddToCollection: boolean;
    isBanned: boolean;
    canBan: boolean;
    localFile: boolean;
    offline: string;
    trackPlayState: {
        isPlayable: boolean;
        playabilityRestriction: string;
    };
    album: {
        link: string;
        name: string;
        covers: {
            default: string;
            small: string;
            large: string;
            xlarge: string;
        };
        artist: {
            link: string;
            name: string;
        };
    };
    artists: Array<{
        link: string;
        name: string;
    }>;
    addTime: number;
    addedBy: {
        username: string;
        link: string;
        name: string;
        image: string;
        thumbnail: string;
    };
    addedAt: string;
    displayCovers: {
        default: string;
        small: string;
        large: string;
        xlarge: string;
    };
};

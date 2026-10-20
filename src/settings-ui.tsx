import * as api from "./api";
import { playlistUris } from "./app";
import { getAllPlaylistItems } from "./ratings";
import { getAotyApiKey, saveAotyApiKey } from "./aoty-settings";
import { testAotyApiKey } from "./aoty";
import { saveSettings } from "./settings";
import type { Scaling, Settings as SettingsConfig } from "./settings";
import { getNowPlayingTrackUri } from "./utils/utils";
import "./settings-ui.css";

const React = Spicetify.React;

type BooleanSettingKey = { [Key in keyof SettingsConfig]: SettingsConfig[Key] extends boolean ? Key : never }[keyof SettingsConfig];
type StringSettingKey = { [Key in keyof SettingsConfig]: SettingsConfig[Key] extends string ? Key : never }[keyof SettingsConfig];
type TabId = "display" | "ratings" | "playback" | "data" | "aoty";

interface SettingsUiProps {
    settings: SettingsConfig;
    registerKeyboardShortcuts: () => void;
    deregisterKeyboardShortcuts: () => void;
    updateTracklist: () => void;
    restoreTracklist: () => void;
    redrawNowPlayingStars: () => void;
    refreshWeightedShuffleButton: () => void;
    refreshAlbumAotyScore: (force?: boolean) => void;
}

const tabs: Array<{ id: TabId; label: string; description: string }> = [
    { id: "display", label: "Display", description: "Stars, labels & placement" },
    { id: "ratings", label: "Rating behavior", description: "How ratings are saved" },
    { id: "playback", label: "Playback", description: "Queues & weighted play" },
    { id: "data", label: "Data & shortcuts", description: "Exports & quick controls" },
    { id: "aoty", label: "AOTY", description: "Scores & quick links" },
];

function SettingCard({ title, description, children, className = "" }: {
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={`sr-settings-card ${className}`}>
            <div className="sr-settings-card-heading">
                <h2>{title}</h2>
                {description && <p>{description}</p>}
            </div>
            <div className="sr-settings-card-content">{children}</div>
        </section>
    );
}

function SettingRow({ title, description, children, className = "" }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={`sr-settings-row ${className}`}>
            <div className="sr-settings-row-copy">
                <div className="sr-settings-row-title">{title}</div>
                {description && <div className="sr-settings-row-description">{description}</div>}
            </div>
            <div className="sr-settings-row-control">{children}</div>
        </div>
    );
}

function ToggleRow({ settings, field, title, description, onChange }: {
    settings: SettingsConfig;
    field: BooleanSettingKey;
    title: string;
    description?: string;
    onChange?: () => void;
}) {
    const [enabled, setEnabled] = React.useState(settings[field]);

    function toggle() {
        const next = !enabled;
        settings[field] = next as never;
        setEnabled(next);
        saveSettings(settings);
        onChange?.();
    }

    return (
        <SettingRow title={title} description={description}>
            <button
                type="button"
                className={`sr-settings-switch${enabled ? " is-on" : ""}`}
                role="switch"
                aria-checked={enabled}
                aria-label={title}
                onClick={toggle}
            >
                <span />
            </button>
        </SettingRow>
    );
}

function SelectRow({ settings, field, title, description, options, onChange, disabled = false }: {
    settings: SettingsConfig;
    field: StringSettingKey;
    title: string;
    description?: string;
    options: Record<string, string>;
    onChange?: () => void;
    disabled?: boolean;
}) {
    const [value, setValue] = React.useState(settings[field]);

    function change(event: React.ChangeEvent<HTMLSelectElement>) {
        const next = event.target.value;
        setValue(next);
        settings[field] = next as never;
        saveSettings(settings);
        onChange?.();
    }

    return (
        <SettingRow title={title} description={description}>
            <select className="sr-settings-select" value={value} onChange={change} aria-label={title} disabled={disabled}>
                {Object.entries(options).map(([label, optionValue]) => <option key={optionValue} value={optionValue}>{label}</option>)}
            </select>
        </SettingRow>
    );
}

function NumberRow({ settings, title, description, field, min, max, step }: {
    settings: SettingsConfig;
    title: string;
    description?: string;
    field: "maxPlaylistItems";
    min: number;
    max: number;
    step: number;
}) {
    const [value, setValue] = React.useState(String(settings[field]));

    function commit(rawValue: string) {
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed)) {
            setValue(String(settings[field]));
            return;
        }
        const next = Math.max(min, Math.min(max, parsed));
        settings[field] = next;
        setValue(String(next));
        saveSettings(settings);
    }

    return (
        <SettingRow title={title} description={description}>
            <input
                className="sr-settings-number"
                type="number"
                value={value}
                min={min}
                max={max}
                step={step}
                aria-label={title}
                onChange={(event) => setValue(event.target.value)}
                onBlur={(event) => commit(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            />
        </SettingRow>
    );
}

function AotyApiKeyRow({ refreshAlbumAotyScore }: { refreshAlbumAotyScore: (force?: boolean) => void }) {
    const [draft, setDraft] = React.useState("");
    const [visible, setVisible] = React.useState(false);
    const [hasKey, setHasKey] = React.useState(Boolean(getAotyApiKey()));
    const [status, setStatus] = React.useState("");
    const [testing, setTesting] = React.useState(false);

    function save() {
        const key = draft.trim();
        if (!key) return;
        if (!saveAotyApiKey(key)) {
            setStatus("Could not save the API key in local Spicetify storage.");
            return;
        }
        setDraft("");
        setHasKey(true);
        setStatus("API key saved locally.");
        refreshAlbumAotyScore(true);
    }

    function clear() {
        if (!saveAotyApiKey("")) {
            setStatus("Could not clear the saved API key.");
            return;
        }
        setDraft("");
        setHasKey(false);
        setStatus("Saved API key cleared.");
        refreshAlbumAotyScore(true);
    }

    async function testKey() {
        setTesting(true);
        setStatus("Testing album search and score details…");
        try {
            setStatus(await testAotyApiKey());
        } catch {
            setStatus("The Parse API test failed unexpectedly. Check the connection and try again.");
        } finally {
            setTesting(false);
        }
    }

    return <>
        <SettingRow
            title="Parse API key (optional)"
            description={<>Used for album search and score details. Without a key, the extension tries the community score source. Create an account and API key on <a href="https://parse.bot/settings" target="_blank" rel="noreferrer">Parse settings</a>.</>}
        >
            <div className="sr-aoty-key-control">
                <div className="sr-aoty-key-input-wrap">
                    <input
                        className="sr-settings-text"
                        type={visible ? "text" : "password"}
                        value={draft}
                        placeholder={hasKey ? "Saved — enter to replace" : "Paste API key"}
                        aria-label="Parse API key"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") save(); }}
                    />
                    <button className="sr-settings-button sr-settings-button-secondary" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide API key" : "Show API key"}>
                        {visible ? "Hide" : "Show"}
                    </button>
                </div>
                <div className="sr-settings-inline-control">
                    <button className="sr-settings-button" type="button" onClick={save} disabled={!draft.trim()}>Save key</button>
                    <button className="sr-settings-button sr-settings-button-secondary" type="button" onClick={() => void testKey()} disabled={!hasKey || testing} title="Tests album search and score details; up to two successful API credits.">{testing ? "Testing…" : "Test key"}</button>
                    <button className="sr-settings-button sr-settings-button-secondary" type="button" onClick={clear} disabled={!hasKey}>Clear</button>
                </div>
                {hasKey && <span className="sr-aoty-key-saved"><span /> Key saved</span>}
            </div>
        </SettingRow>
        <p className="sr-settings-note sr-aoty-key-note" aria-live="polite">
            {status || "Stored in local Spicetify storage and sent to Parse only in the X-API-Key request header. It is not included in settings or rating exports. The fallback can use up to two credits per uncached album."}
        </p>
    </>;
}

function ScalingRow({ settings }: { settings: SettingsConfig }) {
    const [kind, setKind] = React.useState(settings.ratingToWeight.kind);
    const [base, setBase] = React.useState(settings.ratingToWeight.kind === "Exponential" ? settings.ratingToWeight.base : 1);

    function commit(next: Scaling) {
        settings.ratingToWeight = next;
        saveSettings(settings);
    }

    function changeKind(event: React.ChangeEvent<HTMLSelectElement>) {
        const nextKind = event.target.value as Scaling["kind"];
        setKind(nextKind);
        commit(nextKind === "Linear" ? { kind: "Linear" } : { kind: "Exponential", base });
    }

    function changeBase(event: React.ChangeEvent<HTMLInputElement>) {
        const parsed = Number(event.target.value);
        if (!Number.isFinite(parsed) || parsed < 0.01) return;
        const next = Math.min(100, parsed);
        setBase(next);
        if (kind === "Exponential") commit({ kind: "Exponential", base: next });
    }

    return (
        <SettingRow title="Rating-to-weight curve" description="Controls how strongly ratings influence weighted playback and playlists.">
            <div className="sr-settings-inline-control">
                <select className="sr-settings-select" value={kind} onChange={changeKind} aria-label="Rating-to-weight curve">
                    <option value="Linear">Linear</option>
                    <option value="Exponential">Exponential</option>
                </select>
                <label className={`sr-settings-base${kind !== "Exponential" ? " is-disabled" : ""}`}>
                    <span>Base</span>
                    <input type="number" value={base} step={0.1} min={0.01} max={100} disabled={kind !== "Exponential"} onChange={changeBase} aria-label="Exponential base" />
                </label>
            </div>
        </SettingRow>
    );
}

function KeyboardShortcut({ label, numberKey }: { label: string; numberKey: string }) {
    return (
        <div className="sr-shortcut-row">
            <span>{label}</span>
            <span className="sr-shortcut-keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Num {numberKey}</kbd></span>
        </div>
    );
}

function DuplicateSyncCheck() {
    const [checking, setChecking] = React.useState(false);
    const [message, setMessage] = React.useState("");

    async function checkCurrentTrack() {
        const uri = getNowPlayingTrackUri();
        if (!uri?.startsWith("spotify:track:")) {
            setMessage("Play a Spotify track first. Local files do not have Spotify ISRC matches.");
            return;
        }
        setChecking(true);
        setMessage("");
        try {
            const matches = await api.getTracksWithSameISRC(uri);
            const otherMatches = matches.filter((track) => track.uri !== uri);
            if (!otherMatches.length) {
                setMessage(
                    matches.some((track) => track.uri === uri)
                        ? "Found this track only. Spotify has no other indexed releases for its ISRC."
                        : "Spotify returned no tracks for this ISRC. No matching releases were indexed.",
                );
            } else {
                const examples = otherMatches.slice(0, 2).map((track) => {
                    const artists = track.artists.map((artist) => artist.name).join(", ");
                    return artists ? `${track.name} — ${artists}` : track.name;
                });
                const more = otherMatches.length > examples.length ? ` and ${otherMatches.length - examples.length} more` : "";
                setMessage(`Found ${otherMatches.length} matching release${otherMatches.length === 1 ? "" : "s"}: ${examples.join("; ")}${more}.`);
            }
        } catch (error) {
            console.error("Could not check Spotify ISRC matches:", error);
            setMessage("Spotify could not check this track right now. Try again in a moment.");
        } finally {
            setChecking(false);
        }
    }

    return (
        <div className="sr-sync-check">
            <button className="sr-settings-button sr-settings-button-secondary" type="button" disabled={checking} onClick={() => void checkCurrentTrack()}>
                {checking ? "Checking…" : "Check current track"}
            </button>
            {message && <p className="sr-sync-check-message" role="status">{message}</p>}
        </div>
    );
}

async function downloadRatings() {
    try {
        const ratings = await getAllPlaylistItems(playlistUris);
        const blob = new Blob([JSON.stringify(ratings)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const element = document.createElement("a");
        element.href = url;
        element.download = "ratings-export.json";
        element.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error("Could not export ratings:", error);
        Spicetify.showNotification("Could not export ratings. Check Spotify and try again.");
    }
}

async function copyRatings() {
    try {
        const ratings = await getAllPlaylistItems(playlistUris);
        await Spicetify.Platform.ClipboardAPI.copy(JSON.stringify(ratings));
        Spicetify.showNotification("Ratings copied to clipboard.");
    } catch (error) {
        console.error("Could not copy ratings:", error);
        Spicetify.showNotification("Could not copy ratings. Check Spotify and try again.");
    }
}

function SettingsContent({ settings, tab, registerKeyboardShortcuts, deregisterKeyboardShortcuts, updateTracklist, restoreTracklist, redrawNowPlayingStars, refreshWeightedShuffleButton, refreshAlbumAotyScore }: SettingsUiProps & { tab: TabId }) {
    const keyboardChanged = () => settings.enableKeyboardShortcuts ? registerKeyboardShortcuts() : deregisterKeyboardShortcuts();
    const playlistStarsChanged = () => settings.showPlaylistStars ? updateTracklist() : restoreTracklist();
    const nowPlayingPositionChanged = () => redrawNowPlayingStars();

    if (tab === "display") {
        return <>
            <SettingCard title="Song star display" description="Choose the precision and places where your ratings appear.">
                <ToggleRow settings={settings} field="halfStarRatings" title="Half-star ratings" description="Allow ratings in half-star steps." />
                <ToggleRow settings={settings} field="quarterStarRatings" title="Quarter-star ratings" description="Allow ratings in quarter-star steps." />
                <ToggleRow settings={settings} field="showExactRating" title="Show exact rating" description="Show the numeric rating beside the stars." />
                <ToggleRow settings={settings} field="showPlaylistStars" title="Show stars in track lists" description="Add rating stars to Spotify playlist and album track rows." onChange={playlistStarsChanged} />
            </SettingCard>
            <SettingCard title="Placement" description="Fine-tune how ratings sit in Spotify's player.">
                <SelectRow settings={settings} field="nowPlayingStarsPosition" title="Now-playing stars" description="Choose which side of the track title shows its stars." options={{ Left: "left", Right: "right" }} onChange={nowPlayingPositionChanged} />
            </SettingCard>
        </>;
    }

    if (tab === "ratings") {
        return <>
            <SettingCard title="Rating rules" description="Set defaults and choose what happens when you rate a track again.">
                <SelectRow settings={settings} field="defaultRating" title="Default for unrated tracks" description="The starting value shown before a track has a saved rating." options={Object.fromEntries(Array.from({ length: 11 }, (_, index) => { const value = (index / 2).toFixed(1); return [value, value]; }))} />
                <SelectRow settings={settings} field="newRatingPosition" title="Place new ratings" description="Choose whether a new rating goes at the front or back of its rating playlist." options={{ Front: "front", Back: "back" }} />
                <ToggleRow settings={settings} field="averageRatings" title="Keep rating history" description="Record ratings over time and calculate a time-weighted average. Re-ratings within five minutes replace or remove the latest entry." />
                <SelectRow settings={settings} field="likeThreshold" title="Auto-like threshold" description="Automatically like tracks at or above this rating." options={{ Disabled: "disabled", ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => { const value = (3 + index * 0.5).toFixed(1); return [value, value]; })) }} />
                <SelectRow settings={settings} field="skipThreshold" title="Skip low-rated tracks" description="Skip the current track when its rating is at or below this value." options={{ Disabled: "disabled", ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => { const value = (index * 0.5).toFixed(1); return [value, value]; })) }} />
            </SettingCard>
            <SettingCard title="Duplicate-track sync" description="Spotify's ISRC identifies recordings that appear on multiple releases.">
                <ToggleRow settings={settings} field="syncDuplicateSongs" title="Sync ratings across matching releases" description="When you rate a song, also update unrated duplicates. Previously synced copies stay together; a copy with a different independent rating is left alone." />
                <div className="sr-settings-row sr-settings-row-diagnostic">
                    <div className="sr-settings-row-copy">
                        <div className="sr-settings-row-title">Troubleshoot matching</div>
                        <div className="sr-settings-row-description">Check Spotify's ISRC search for the currently playing track. This does not change any ratings.</div>
                    </div>
                    <div className="sr-settings-row-control"><DuplicateSyncCheck /></div>
                </div>
            </SettingCard>
        </>;
    }

    if (tab === "playback") {
        return <>
            <SettingCard title="Playback mode" description="Control which tracks are eligible during rating-aware playback.">
                <SelectRow settings={settings} field="play" title="Play" description="Choose whether playback uses all tracks, rated tracks, or unrated tracks." options={{ "All tracks": "all", "Only rated": "onlyrated", "Only unrated": "onlyunrated" }} />
                <ToggleRow settings={settings} field="showWeightedShuffle" title="Show weighted-shuffle control" description="Add the W control beside Spotify's shuffle button." onChange={refreshWeightedShuffleButton} />
                <ScalingRow settings={settings} />
            </SettingCard>
            <SettingCard title="Compatibility" description="Optional workarounds for specific Spotify playback behavior.">
                <ToggleRow settings={settings} field="reEnqueueWorkaround" title="Re-enqueue remote-play workaround" description="After a short delay, re-add a track if Spotify drops it during remote playback." />
            </SettingCard>
        </>;
    }

    if (tab === "aoty") {
        return <>
            <SettingCard title="Album of the Year score" description="Show the selected AOTY rating directly beneath your album stars.">
                <ToggleRow settings={settings} field="showAotyAlbumScore" title="Show AOTY score on album pages" description="Looks up the album’s score and displays it in a 0–100 format, such as 93/100." onChange={refreshAlbumAotyScore} />
                <SelectRow settings={settings} field="aotyScoreType" title="Score to display" description="Choose which AOTY score appears. If that score is missing for an album, no other score is substituted." options={{ "Critic score": "critic", "User score": "user" }} disabled={!settings.showAotyAlbumScore} onChange={() => refreshAlbumAotyScore(true)} />
            </SettingCard>
            <SettingCard title="Open pages in AOTY" description="Adds an Album of the Year item to the Spotify three-dot menu for each enabled page type.">
                <ToggleRow settings={settings} field="openAlbumsInAoty" title="Enable for album pages" description="Add “Open album in AOTY” to album menus." />
                <ToggleRow settings={settings} field="openArtistsInAoty" title="Enable for artist pages" description="Add “Open artist in AOTY” to artist menus." />
            </SettingCard>
            <SettingCard title="Score lookup fallback" description="Optionally add your own Parse key so album scores can still load when the community service is blocked or unavailable.">
                <AotyApiKeyRow refreshAlbumAotyScore={refreshAlbumAotyScore} />
            </SettingCard>
            <p className="sr-settings-note sr-aoty-note">AOTY lookups require an internet connection and send only the public album or artist name to the score provider—never Spotify account data. Without a key, scores use the no-key community API; if both sources fail, scores stay unavailable and menu links fall back to AOTY search.</p>
        </>;
    }

    return <>
        <SettingCard title="Data & maintenance" description="Keep exports portable and rating playlists responsive.">
            <NumberRow settings={settings} field="maxPlaylistItems" title="Maximum tracks per rating playlist" description="Smaller rating playlists can make saving new ratings faster. Spotify's limit is 10,000." min={1} max={10000} step={100} />
            <SettingRow title="Export your ratings" description="Save a portable JSON copy or copy it for backup.">
                <div className="sr-settings-inline-control">
                    <button className="sr-settings-button sr-settings-button-secondary" type="button" onClick={() => void copyRatings()}>Copy JSON</button>
                    <button className="sr-settings-button" type="button" onClick={() => void downloadRatings()}>Download</button>
                </div>
            </SettingRow>
        </SettingCard>
        <SettingCard title="Keyboard shortcuts" description="Shortcuts apply ratings to the currently playing Spotify track.">
            <ToggleRow settings={settings} field="enableKeyboardShortcuts" title="Enable rating shortcuts" description="Use Ctrl + Alt + a numpad key to set the rating." onChange={keyboardChanged} />
            {settings.enableKeyboardShortcuts ? (
                <div className="sr-shortcuts-list">
                    <KeyboardShortcut label="0.5 stars" numberKey="1" />
                    <KeyboardShortcut label="1 star" numberKey="2" />
                    <KeyboardShortcut label="1.5 stars" numberKey="3" />
                    <KeyboardShortcut label="2 stars" numberKey="4" />
                    <KeyboardShortcut label="2.5 stars" numberKey="5" />
                    <KeyboardShortcut label="3 stars" numberKey="6" />
                    <KeyboardShortcut label="3.5 stars" numberKey="7" />
                    <KeyboardShortcut label="4 stars" numberKey="8" />
                    <KeyboardShortcut label="4.5 stars" numberKey="9" />
                    <KeyboardShortcut label="5 stars" numberKey="0" />
                </div>
            ) : <p className="sr-settings-note">Turn on shortcuts to see the rating key map.</p>}
        </SettingCard>
    </>;
}

export function Settings(props: SettingsUiProps) {
    const [activeTab, setActiveTab] = React.useState("display" as TabId);
    const activeTabInfo = tabs.find((tab) => tab.id === activeTab)!;

    return (
        <div className="sr-settings">
            <header className="sr-settings-header">
                <div className="sr-settings-header-mark" aria-hidden="true">★</div>
                <div className="sr-settings-header-copy">
                    <div className="sr-settings-eyebrow">STAR RATINGS</div>
                    <h1>Make ratings yours</h1>
                    <p>Shape how your ratings look, behave, and guide playback.</p>
                </div>
                <div className="sr-settings-saved"><span /> Saved automatically</div>
            </header>
            <nav className="sr-settings-tabs" aria-label="Settings categories">
                {tabs.map((tab) => (
                    <button key={tab.id} type="button" className={`sr-settings-tab${tab.id === activeTab ? " is-active" : ""}`} aria-current={tab.id === activeTab ? "page" : undefined} onClick={() => setActiveTab(tab.id)}>
                        <span>{tab.label}</span>
                        <small>{tab.description}</small>
                    </button>
                ))}
            </nav>
            <main className="sr-settings-main" key={activeTab}>
                <div className="sr-settings-section-title">
                    <div>
                        <h2>{activeTabInfo.label}</h2>
                        <p>{activeTabInfo.description}</p>
                    </div>
                </div>
                <SettingsContent {...props} tab={activeTab} />
                <footer className="sr-settings-footer">Changes are saved in Spotify and take effect right away.</footer>
            </main>
        </div>
    );
}

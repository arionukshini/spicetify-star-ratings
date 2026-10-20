import * as api from "./api";

const AOTY_API_KEY_STORAGE_KEY = "starRatings:aotyApiKey";
let aotyApiKeyRevision = 0;

export function getAotyApiKey(): string {
    try {
        const value = api.getLocalStorageData(AOTY_API_KEY_STORAGE_KEY);
        return typeof value === "string" ? value.trim() : "";
    } catch {
        return "";
    }
}

export function saveAotyApiKey(value: string): boolean {
    try {
        api.setLocalStorageData(AOTY_API_KEY_STORAGE_KEY, value.trim());
        aotyApiKeyRevision++;
        return true;
    } catch {
        return false;
    }
}

export function getAotyApiKeyRevision(): number {
    return aotyApiKeyRevision;
}

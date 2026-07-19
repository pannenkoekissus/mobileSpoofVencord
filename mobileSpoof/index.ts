/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    mobilePlatform: {
        type: OptionType.SELECT,
        description: "The mobile platform to spoof. Requires Discord reload to take effect.",
        options: [
            { label: "Android", value: "Android", default: true },
            { label: "iOS", value: "iOS" }
        ],
        restartNeeded: true
    }
});

// ─── State ────────────────────────────────────────────────────────────────────

let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
let originalWsSend: typeof WebSocket.prototype.send | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPlatformInfo() {
    const isIOS = settings.store.mobilePlatform === "iOS";
    return {
        os: isIOS ? "iOS" : "Android",
        browser: isIOS ? "Discord iOS" : "Discord Android",
        device: isIOS ? "Discord iOS" : "Discord Android"
    };
}


/**
 * Build a fully valid mobile X-Super-Properties value.
 * We completely replace desktop fields to prevent Discord backend validation errors,
 * and we use a modern build number to prevent Discord from hiding quests from "outdated" clients.
 */
function patchSuperPropsBase64(existingBase64: string): string {
    const isIOS = settings.store.mobilePlatform === "iOS";
    try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(existingBase64))));
        const system_locale = decoded.system_locale || "en-US";
        
        const mobileProps = isIOS ? {
            os: "iOS",
            browser: "Discord iOS",
            device: "iPhone14,2",
            system_locale,
            client_version: "337.0",
            release_channel: "stable",
            os_version: "17.5",
            client_build_number: 337000,
            client_event_source: null
        } : {
            os: "Android",
            browser: "Discord Android",
            device: "Pixel 8",
            system_locale,
            client_version: "337.10",
            release_channel: "googleRelease",
            os_version: "34",
            client_build_number: 337010,
            client_event_source: null
        };
        
        return btoa(unescape(encodeURIComponent(JSON.stringify(mobileProps))));
    } catch {
        // If we can't parse, return unchanged
        return existingBase64;
    }
}

/**
 * All quest-related endpoints that need X-Super-Properties spoofed.
 * This includes both the main list fetch and the progress endpoints.
 */
function isQuestUrl(url: string): boolean {
    return url.includes("/quests") || url.includes("/drops");
}

function isDiscordApiUrl(url: string): boolean {
    return (
        url.startsWith("/api/") ||
        url.startsWith("https://discord.com/api/") ||
        url.startsWith("https://canary.discord.com/api/") ||
        url.startsWith("https://ptb.discord.com/api/") ||
        url.startsWith("https://discordapp.com/api/") ||
        url.includes("discord.com/api") ||
        url.includes("discordapp.com/api")
    );
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "MobileSpoof",
    description: "Makes Discord think you are on mobile — shows mobile status indicator and allows mobile-only quests.",
    tags: ["Utility", "Privacy"],
    authors: [Devs.Ven],
    settings,
    startAt: StartAt.Init,

    start() {
        // ── 1. WebSocket.send — patch Gateway IDENTIFY (op 2) ────────────────
        originalWsSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (typeof data === "string") {
                try {
                    const isGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));
                    if (isGateway) {
                        const parsed = JSON.parse(data);
                        if (parsed.op === 2 && parsed.d?.properties) {
                            const { os, browser, device } = getPlatformInfo();
                            parsed.d.properties.$os = os;
                            parsed.d.properties.$browser = browser;
                            parsed.d.properties.$device = device;
                            data = JSON.stringify(parsed);
                        }
                    }
                } catch { /* ignore */ }
            }
            return originalWsSend!.call(this, data);
        };

        // ── 2. window.fetch — patch headers on quest endpoints ───────────────
        originalFetch = window.fetch;
        window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
            try {
                const url = input instanceof Request ? input.url
                    : input instanceof URL ? input.href
                        : String(input);

                if (!isDiscordApiUrl(url) || !isQuestUrl(url)) {
                    return originalFetch!.call(this, input, init);
                }

                // Clone headers first so we can inspect X-Super-Properties
                const headers = new Headers(
                    input instanceof Request ? input.headers : (init?.headers ?? {})
                );

                const existingProps = headers.get("X-Super-Properties");
                if (existingProps) {
                    headers.set("X-Super-Properties", patchSuperPropsBase64(existingProps));
                }

                if (input instanceof Request) {
                    return originalFetch!.call(this, new Request(input, { ...init, headers }));
                }
                return originalFetch!.call(this, input, { ...init, headers });
            } catch (e) {
                // Fall back to original fetch if anything fails
                return originalFetch!.call(this, input, init);
            }
        } as typeof window.fetch;

        // ── 3. XMLHttpRequest — patch headers on quest endpoints ─────────────
        originalXhrOpen = XMLHttpRequest.prototype.open;
        originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

        const xhrUrlMap = new WeakMap<XMLHttpRequest, string>();

        XMLHttpRequest.prototype.open = function (
            this: XMLHttpRequest,
            method: string,
            url: string | URL,
            ...rest: any[]
        ) {
            const urlStr = String(url);
            xhrUrlMap.set(this, urlStr);
            
            return (originalXhrOpen as any).call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.setRequestHeader = function (
            this: XMLHttpRequest,
            name: string,
            value: string
        ) {
            const url = xhrUrlMap.get(this) ?? "";
            if (isDiscordApiUrl(url) && isQuestUrl(url)) {
                if (name.toLowerCase() === "x-super-properties") {
                    value = patchSuperPropsBase64(value);
                }
            }
            return originalXhrSetHeader!.call(this, name, value);
        };
    },

    stop() {
        if (originalWsSend) {
            WebSocket.prototype.send = originalWsSend;
            originalWsSend = null;
        }
        if (originalFetch) {
            window.fetch = originalFetch;
            originalFetch = null;
        }
        if (originalXhrOpen) {
            XMLHttpRequest.prototype.open = originalXhrOpen;
            originalXhrOpen = null;
        }
        if (originalXhrSetHeader) {
            XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader;
            originalXhrSetHeader = null;
        }
    }
});

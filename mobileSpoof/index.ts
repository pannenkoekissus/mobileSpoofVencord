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

let originalWsSend: typeof WebSocket.prototype.send | null = null;
let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

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
        return existingBase64;
    }
}

/**
 * Inject platform 1 (Desktop) into every quest so the UI shows
 * "Accept Quest" instead of a QR code for mobile-only quests.
 */
function patchQuestPlatforms(data: any): { data: any; modified: boolean; } {
    let modified = false;
    if (Array.isArray(data)) {
        for (const quest of data) {
            const platforms = quest?.config?.platforms;
            if (Array.isArray(platforms) && !platforms.includes(1)) {
                platforms.push(1);
                modified = true;
            }
        }
    }
    return { data, modified };
}

function isQuestUrl(url: string): boolean {
    return url.includes("/quests") || url.includes("/drops");
}

function isQuestListUrl(url: string): boolean {
    return url.includes("/users/@me/quests");
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
        // ── 1. WebSocket.send — patch Gateway IDENTIFY ────────────────────────
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

        // ── 2. window.fetch — patch headers on quest requests & inject Desktop
        //       platform into quest list responses so UI shows Accept button ───
        originalFetch = window.fetch;
        window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
            try {
                const urlStr = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);

                if (!isDiscordApiUrl(urlStr) || !isQuestUrl(urlStr)) {
                    return originalFetch!.call(this, input, init);
                }

                // Patch outgoing X-Super-Properties header
                const headers = new Headers(input instanceof Request ? input.headers : (init?.headers ?? {}));
                const existingProps = headers.get("X-Super-Properties");
                if (existingProps) {
                    headers.set("X-Super-Properties", patchSuperPropsBase64(existingProps));
                }

                const patchedRequest = input instanceof Request
                    ? new Request(input, { ...init, headers })
                    : [urlStr, { ...init, headers }] as const;

                const response = await (Array.isArray(patchedRequest)
                    ? originalFetch!.call(this, patchedRequest[0], patchedRequest[1])
                    : originalFetch!.call(this, patchedRequest));

                // Intercept quest list response to inject Desktop platform
                if (isQuestListUrl(urlStr) && response.ok) {
                    try {
                        const json = await response.clone().json();
                        const { data, modified } = patchQuestPlatforms(json);
                        if (modified) {
                            return new Response(JSON.stringify(data), {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers
                            });
                        }
                    } catch { /* fallback to original response */ }
                }

                return response;
            } catch (e) {
                return originalFetch!.call(this, input, init);
            }
        } as typeof window.fetch;

        // ── 3. XMLHttpRequest — patch headers & inject Desktop platform ───────
        originalXhrOpen = XMLHttpRequest.prototype.open;
        originalXhrSend = XMLHttpRequest.prototype.send;
        originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

        const xhrUrlMap = new WeakMap<XMLHttpRequest, string>();

        XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
            xhrUrlMap.set(this, String(url));
            return (originalXhrOpen as any).call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
            const url = xhrUrlMap.get(this) ?? "";
            if (isDiscordApiUrl(url) && isQuestUrl(url) && name.toLowerCase() === "x-super-properties") {
                value = patchSuperPropsBase64(value);
            }
            return originalXhrSetHeader!.call(this, name, value);
        };

        XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
            const url = xhrUrlMap.get(this) ?? "";
            if (isDiscordApiUrl(url) && isQuestListUrl(url)) {
                this.addEventListener("readystatechange", function () {
                    if (this.readyState !== 4) return;
                    try {
                        const json = JSON.parse(this.responseText);
                        const { data, modified } = patchQuestPlatforms(json);
                        if (modified) {
                            const patched = JSON.stringify(data);
                            Object.defineProperty(this, "responseText", { get: () => patched, configurable: true });
                            Object.defineProperty(this, "response", { get: () => patched, configurable: true });
                        }
                    } catch { /* ignore */ }
                });
            }
            return (originalXhrSend as any).call(this, body);
        };
    },

    stop() {
        if (originalWsSend) { WebSocket.prototype.send = originalWsSend; originalWsSend = null; }
        if (originalFetch) { window.fetch = originalFetch; originalFetch = null; }
        if (originalXhrOpen) { XMLHttpRequest.prototype.open = originalXhrOpen; originalXhrOpen = null; }
        if (originalXhrSend) { XMLHttpRequest.prototype.send = originalXhrSend; originalXhrSend = null; }
        if (originalXhrSetHeader) { XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader; originalXhrSetHeader = null; }
    }
});

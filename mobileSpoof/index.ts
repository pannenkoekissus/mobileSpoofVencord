/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { waitFor } from "@webpack";

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
let superPropsModule: any = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;

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
 * Build a mobile X-Super-Properties value, using the existing one as base
 * so we don't break any other fields Discord needs.
 */
function patchSuperPropsBase64(existingBase64: string): string {
    const { os, browser, device } = getPlatformInfo();
    try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(existingBase64))));
        // Only change the three client-identity fields — leave everything else intact
        decoded.os = os;
        decoded.browser = browser;
        decoded.device = device;
        return btoa(unescape(encodeURIComponent(JSON.stringify(decoded))));
    } catch {
        // If we can't parse, return unchanged
        return existingBase64;
    }
}

/**
 * Quest-related endpoints that need mobile headers to count progress.
 * We intentionally do NOT touch other Discord API calls.
 */
function isQuestUrl(url: string): boolean {
    return url.includes("/drops") || url.includes("/quests");
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

/**
 * Helper to safely redefine properties of objects (handles read-only and getters).
 */
function overrideProperty(obj: any, prop: string, newValue: any): any {
    const originalValue = obj ? obj[prop] : undefined;
    if (obj) {
        try {
            Object.defineProperty(obj, prop, {
                value: newValue,
                writable: true,
                configurable: true,
                enumerable: true
            });
        } catch {
            try {
                obj[prop] = newValue;
            } catch { /* ignore */ }
        }
    }
    return originalValue;
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

        // ── 2. window.fetch — only patch X-Super-Properties on quest endpoints ─
        originalFetch = window.fetch;
        window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
            try {
                const url = input instanceof Request ? input.url
                    : input instanceof URL ? input.href
                        : String(input);

                if (!isDiscordApiUrl(url)) {
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

                // For quest heartbeat/progress endpoints, also spoof the User-Agent
                if (isQuestUrl(url)) {
                    const { os } = getPlatformInfo();
                    const mobileUA = os === "iOS"
                        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
                        : "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
                    headers.set("User-Agent", mobileUA);
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

        // ── 3. XMLHttpRequest — only patch X-Super-Properties header ─────────
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
            
            const res = (originalXhrOpen as any).call(this, method, url, ...rest);

            // Set User-Agent for quest URLs on open
            if (isDiscordApiUrl(urlStr) && isQuestUrl(urlStr)) {
                try {
                    const { os } = getPlatformInfo();
                    const mobileUA = os === "iOS"
                        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
                        : "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
                    originalXhrSetHeader!.call(this, "User-Agent", mobileUA);
                } catch { /* ignore */ }
            }

            return res;
        };

        XMLHttpRequest.prototype.setRequestHeader = function (
            this: XMLHttpRequest,
            name: string,
            value: string
        ) {
            const url = xhrUrlMap.get(this) ?? "";
            if (isDiscordApiUrl(url)) {
                const lowerName = name.toLowerCase();
                if (lowerName === "x-super-properties") {
                    value = patchSuperPropsBase64(value);
                } else if (lowerName === "user-agent" && isQuestUrl(url)) {
                    const { os } = getPlatformInfo();
                    value = os === "iOS"
                        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
                        : "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
                }
            }
            return originalXhrSetHeader!.call(this, name, value);
        };

        // ── 4. Webpack getSuperProperties module ─────────────────────────────
        waitFor(["getSuperProperties", "getSuperPropertiesBase64"], mod => {
            if (!originalWsSend) return; // plugin has been stopped already

            superPropsModule = mod;
            originalGetSuperProperties = mod.getSuperProperties;
            originalGetSuperPropertiesBase64 = mod.getSuperPropertiesBase64;

            overrideProperty(mod, "getSuperProperties", function () {
                const props = originalGetSuperProperties.apply(this, arguments);
                const { os, browser, device } = getPlatformInfo();
                // Only change the identity fields, leave everything else untouched
                props.os = os;
                props.browser = browser;
                props.device = device;
                return props;
            });

            overrideProperty(mod, "getSuperPropertiesBase64", function () {
                const props = mod.getSuperProperties.apply(this, arguments);
                return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
            });
        });
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
        if (superPropsModule) {
            if (originalGetSuperProperties) {
                overrideProperty(superPropsModule, "getSuperProperties", originalGetSuperProperties);
            }
            if (originalGetSuperPropertiesBase64) {
                overrideProperty(superPropsModule, "getSuperPropertiesBase64", originalGetSuperPropertiesBase64);
            }
            superPropsModule = null;
            originalGetSuperProperties = null;
            originalGetSuperPropertiesBase64 = null;
        }
    }
});

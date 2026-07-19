/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { findByProps } from "@webpack";

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
let originalGetSuperProperties: any = null;
let superPropsMod: any = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPlatformInfo() {
    const isIOS = settings.store.mobilePlatform === "iOS";
    return {
        os: isIOS ? "iOS" : "Android",
        browser: isIOS ? "Discord iOS" : "Discord Android",
        device: isIOS ? "Discord iOS" : "Discord Android"
    };
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

        // ── 2. Webpack — Patch Internal Properties for React UI & API ────────
        superPropsMod = findByProps("getSuperProperties");
        if (superPropsMod && typeof superPropsMod.getSuperProperties === "function") {
            originalGetSuperProperties = superPropsMod.getSuperProperties;
            
            // We completely overwrite the internal properties to trick the React UI 
            // into believing we are on a mobile device, which enables the "Accept Quest" button.
            // This also automatically handles the X-Super-Properties for all API requests!
            superPropsMod.getSuperProperties = function () {
                const isIOS = settings.store.mobilePlatform === "iOS";
                const system_locale = "en-US";
                
                return isIOS ? {
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
            };
        }
    },

    stop() {
        if (originalWsSend) {
            WebSocket.prototype.send = originalWsSend;
            originalWsSend = null;
        }
        
        if (superPropsMod && originalGetSuperProperties) {
            superPropsMod.getSuperProperties = originalGetSuperProperties;
            originalGetSuperProperties = null;
            superPropsMod = null;
        }
    }
});

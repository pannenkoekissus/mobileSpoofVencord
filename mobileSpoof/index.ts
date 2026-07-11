/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { waitFor } from "@webpack";

const settings = definePluginSettings({
    mobileSpoofEnabled: {
        type: OptionType.BOOLEAN,
        description: "Force Discord to think you are connecting from a mobile device (requires reload/reconnect).",
        default: true,
        restartNeeded: true
    },
    mobilePlatform: {
        type: OptionType.SELECT,
        description: "The mobile platform to spoof.",
        options: [
            { label: "Android", value: "Android", default: true },
            { label: "iOS", value: "iOS" }
        ],
        restartNeeded: true
    }
});

let originalSend: typeof WebSocket.prototype.send | null = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;
let patchedModule: any = null;

export default definePlugin({
    name: "MobileSpoof",
    description: "Spoofs your device status to make it appear as a mobile device to other users.",
    tags: ["Utility", "Privacy"],
    authors: [Devs.Ven],
    settings,
    startAt: StartAt.Init,

    start() {
        // 1. Hook the global WebSocket prototype send method
        originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (typeof data === "string" && settings.store.mobileSpoofEnabled) {
                try {
                    const isDiscordGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));
                    if (isDiscordGateway) {
                        const parsed = JSON.parse(data);
                        // op: 2 is Gateway IDENTIFY handshake
                        if (parsed.op === 2 && parsed.d && parsed.d.properties) {
                            const platform = settings.store.mobilePlatform;
                            const deviceName = platform === "iOS" ? "Discord iOS" : "Discord Android";

                            parsed.d.properties.$os = platform;
                            parsed.d.properties.$browser = deviceName;
                            parsed.d.properties.$device = deviceName;

                            data = JSON.stringify(parsed);
                        }
                    }
                } catch (e) {
                    // Fail-safe: ignore JSON parse/stringify errors
                }
            }
            return originalSend!.call(this, data);
        };

        // 2. Hook Webpack getSuperProperties / getSuperPropertiesBase64 module to spoof REST API header
        waitFor(["getSuperProperties", "getSuperPropertiesBase64"], mod => {
            // Check if the plugin was stopped before the module resolved
            if (!originalSend) return;

            patchedModule = mod;
            originalGetSuperProperties = mod.getSuperProperties;
            originalGetSuperPropertiesBase64 = mod.getSuperPropertiesBase64;

            mod.getSuperProperties = function () {
                const props = originalGetSuperProperties.apply(this, arguments);
                if (settings.store.mobileSpoofEnabled) {
                    const platform = settings.store.mobilePlatform;
                    const deviceName = platform === "iOS" ? "Discord iOS" : "Discord Android";
                    props.os = platform;
                    props.browser = deviceName;
                    props.device = deviceName;
                }
                return props;
            };

            mod.getSuperPropertiesBase64 = function () {
                if (settings.store.mobileSpoofEnabled) {
                    const props = mod.getSuperProperties.apply(this, arguments);
                    return btoa(JSON.stringify(props));
                }
                return originalGetSuperPropertiesBase64.apply(this, arguments);
            };
        });
    },

    stop() {
        // Restore WebSocket send
        if (originalSend) {
            WebSocket.prototype.send = originalSend;
            originalSend = null;
        }

        // Restore Webpack module methods
        if (patchedModule) {
            if (originalGetSuperProperties) {
                patchedModule.getSuperProperties = originalGetSuperProperties;
                originalGetSuperProperties = null;
            }
            if (originalGetSuperPropertiesBase64) {
                patchedModule.getSuperPropertiesBase64 = originalGetSuperPropertiesBase64;
                originalGetSuperPropertiesBase64 = null;
            }
            patchedModule = null;
        }
    }
});

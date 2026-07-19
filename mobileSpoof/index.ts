/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { findByPropsLazy, waitFor } from "@webpack";

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

// ─── Internal Modules (lazy — available after Discord loads) ──────────────────

// Discord's authenticated REST API client — handles auth token automatically
const RestAPI = findByPropsLazy("getAPIBaseURL", "get", "post");

// ─── State ────────────────────────────────────────────────────────────────────

let originalWsSend: typeof WebSocket.prototype.send | null = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;
let patchedModule: any = null;
let observer: MutationObserver | null = null;

// ─── Internal Module Access (for QuestsStore) ─────────────────────────────────

function getQuestsStore(): any {
    try {
        const wpChunk = (window as any).webpackChunkdiscord_app;
        if (!wpChunk) return null;
        const wpRequire = wpChunk.push([[Symbol()], {}, (r: any) => r]);
        wpChunk.pop();
        const modules = Object.values(wpRequire.c) as any[];
        // Try multiple selector patterns since Discord's minified names change
        return (
            modules.find(x => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z ??
            modules.find(x => x?.exports?.default?.__proto__?.getQuest)?.exports?.default ??
            null
        );
    } catch {
        return null;
    }
}

// ─── Quest Enrollment via Internal REST API ───────────────────────────────────

async function enrollInQuest(questId: string, questName: string) {
    try {
        // Use Discord's own authenticated REST API — no manual auth token needed
        const res = await RestAPI.post({ url: `/quests/${questId}/enroll` });

        if (res?.ok || res?.status === 200) {
            showNotification({
                title: "📱 Mobile Quest Started!",
                body: `Enrolled in "${questName}". Reload Discord to see the updated status.`,
                color: "#3ba55c"
            });
            // Re-inject buttons so this one updates to "Enrolled"
            setTimeout(addMobileStartButtons, 500);
        } else {
            showNotification({
                title: "Enrollment Failed",
                body: `Error ${res?.status}: ${JSON.stringify(res?.body ?? {})}`,
                color: "#ed4245"
            });
        }
    } catch (e: any) {
        showNotification({
            title: "Enrollment Error",
            body: String(e?.message ?? e),
            color: "#ed4245"
        });
    }
}

// ─── DOM Button Injection ─────────────────────────────────────────────────────

function addMobileStartButtons() {
    const QuestsStore = getQuestsStore();
    if (!QuestsStore) return;

    const quests = [...(QuestsStore.quests?.values() ?? [])];

    // Find quests that don't include platform 1 (Desktop)
    // 1 = Desktop, 2 = Android, 3 = iOS
    const mobileQuests = quests.filter((q: any) => {
        const platforms: number[] | undefined = q?.config?.platforms;
        return Array.isArray(platforms) && !platforms.includes(1);
    });

    if (mobileQuests.length === 0) return;

    // Try multiple possible class name patterns Discord uses for quest card buttons
    const containerSelectors = [
        'div[class*="headingControls"]',
        'div[class*="contentFooterButtonCont"]',
        'div[class*="questActions"]',
        'div[class*="questCard"] div[class*="actions"]',
        'div[class*="questFooter"]',
    ];

    for (const quest of mobileQuests) {
        const questId: string = quest.id;
        const questName: string =
            quest.config?.messages?.questName ??
            quest.config?.application?.name ??
            "Mobile Quest";
        const isEnrolled = !!quest.userStatus?.enrolledAt;

        if (document.querySelector(`#ms-btn-${questId}`)) continue;

        for (const selector of containerSelectors) {
            const containers = document.querySelectorAll(selector);
            if (containers.length === 0) continue;

            for (const container of containers) {
                if (document.querySelector(`#ms-btn-${questId}`)) break;

                const btn = document.createElement("button");
                btn.id = `ms-btn-${questId}`;

                // Copy styling from an existing button so it blends in
                const existingBtn = container.querySelector("button");
                btn.className = existingBtn?.className ?? "";
                btn.style.cssText = "border: 1px solid #5865f2 !important; margin-left: 8px; cursor: pointer;";
                btn.innerText = isEnrolled ? "📱 Enrolled" : "📱 Start Mobile";
                btn.title = `Force-enroll in "${questName}" using mobile spoof`;

                if (!isEnrolled) {
                    btn.addEventListener("click", e => {
                        e.stopPropagation();
                        enrollInQuest(questId, questName);
                    });
                }

                container.appendChild(btn);
            }
            break; // Only use first selector that finds containers
        }
    }
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
        // ── 1. WebSocket.send — patch Gateway IDENTIFY (mobile status dot) ────
        originalWsSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (typeof data === "string") {
                try {
                    const isGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));
                    if (isGateway) {
                        const parsed = JSON.parse(data);
                        if (parsed.op === 2 && parsed.d?.properties) {
                            const isIOS = settings.store.mobilePlatform === "iOS";
                            parsed.d.properties.$os = isIOS ? "iOS" : "Android";
                            parsed.d.properties.$browser = isIOS ? "Discord iOS" : "Discord Android";
                            parsed.d.properties.$device = isIOS ? "Discord iOS" : "Discord Android";
                            data = JSON.stringify(parsed);
                        }
                    }
                } catch { /* ignore */ }
            }
            return originalWsSend!.call(this, data);
        };

        // ── 2. Patch getSuperProperties so all REST calls look mobile ─────────
        waitFor(["getSuperProperties", "getSuperPropertiesBase64"], mod => {
            if (!originalWsSend) return;
            patchedModule = mod;
            originalGetSuperProperties = mod.getSuperProperties;
            originalGetSuperPropertiesBase64 = mod.getSuperPropertiesBase64;

            mod.getSuperProperties = function () {
                const props = originalGetSuperProperties.apply(this, arguments);
                const isIOS = settings.store.mobilePlatform === "iOS";
                props.os = isIOS ? "iOS" : "Android";
                props.browser = isIOS ? "Discord iOS" : "Discord Android";
                props.device = isIOS ? "Discord iOS" : "Discord Android";
                props.client_build_number = isIOS ? 337000 : 337010;
                props.client_version = isIOS ? "337.0" : "337.10";
                props.release_channel = isIOS ? "stable" : "googleRelease";
                return props;
            };

            mod.getSuperPropertiesBase64 = function () {
                const props = mod.getSuperProperties.apply(this, arguments);
                return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
            };
        });

        // ── 3. MutationObserver — inject "📱 Start Mobile" button ────────────
        // No title check — works regardless of language (Dutch/English/etc.)
        // Deduplication by button ID prevents spamming
        observer = new MutationObserver(() => {
            addMobileStartButtons();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Also try immediately in case quest page is already open
        setTimeout(addMobileStartButtons, 2000);
    },

    stop() {
        if (originalWsSend) {
            WebSocket.prototype.send = originalWsSend;
            originalWsSend = null;
        }
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
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        document.querySelectorAll("[id^='ms-btn-']").forEach(el => el.remove());
    }
});

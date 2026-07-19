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

// ─── Internal Modules ─────────────────────────────────────────────────────────

const RestAPI = findByPropsLazy("getAPIBaseURL", "get", "post");
const QuestsStoreLazy = findByPropsLazy("getQuest", "quests");

// ─── State ────────────────────────────────────────────────────────────────────

let originalWsSend: typeof WebSocket.prototype.send | null = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;
let uiInitTimeout: ReturnType<typeof setTimeout> | null = null;
let patchedModule: any = null;
let observer: MutationObserver | null = null;
let floatingContainer: HTMLDivElement | null = null;

// ─── QuestsStore Access ───────────────────────────────────────────────────────

function getQuestsStore(): any {
    try {
        // QuestsStoreLazy is resolved by Vencord's webpack finder at runtime
        const store = QuestsStoreLazy as any;
        if (store && store.quests) return store;
        console.log("[MobileSpoof] QuestsStore not yet ready");
        return null;
    } catch (e) {
        console.error("[MobileSpoof] getQuestsStore error:", e);
        return null;
    }
}

// ─── Quest Enrollment ─────────────────────────────────────────────────────────

async function enrollInQuest(questId: string, questName: string) {
    try {
        console.log("[MobileSpoof] Enrolling in quest:", questId, questName);
        const res = await RestAPI.post({ url: `/quests/${questId}/enroll` });
        console.log("[MobileSpoof] Enroll response:", res?.status, res?.body);

        if (res?.ok || res?.status === 200 || res?.status === 201) {
            showNotification({
                title: "📱 Mobile Quest Started!",
                body: `Enrolled in "${questName}". Reload Discord to see updated status.`,
                color: "#3ba55c"
            });
            updateFloatingUI();
        } else {
            showNotification({
                title: "Enrollment Failed",
                body: `Status ${res?.status}: ${JSON.stringify(res?.body ?? {})}`,
                color: "#ed4245"
            });
        }
    } catch (e: any) {
        console.error("[MobileSpoof] Enroll error:", e);
        showNotification({
            title: "Enrollment Error",
            body: String(e?.message ?? e),
            color: "#ed4245"
        });
    }
}

// ─── Floating UI ──────────────────────────────────────────────────────────────

function updateFloatingUI() {
    const store = getQuestsStore();

    if (!floatingContainer) return;

    if (!store) {
        console.log("[MobileSpoof] updateFloatingUI: no store");
        floatingContainer.style.display = "none";
        return;
    }

    const allQuests = [...(store.quests?.values() ?? [])];
    console.log("[MobileSpoof] All quests:", allQuests.length, allQuests.map((q: any) => ({
        id: q.id,
        platforms: q?.config?.platforms,
        enrolled: !!q?.userStatus?.enrolledAt,
        completed: !!q?.userStatus?.completedAt,
        name: q?.config?.messages?.questName ?? q?.config?.application?.name
    })));

    // Mobile-only = platforms does NOT include 1 (Desktop)
    const mobileQuests = allQuests.filter((q: any) => {
        const platforms: number[] | undefined = q?.config?.platforms;
        return Array.isArray(platforms) && !platforms.includes(1);
    });

    console.log("[MobileSpoof] Mobile-only quests:", mobileQuests.length);

    if (mobileQuests.length === 0) {
        floatingContainer.style.display = "none";
        return;
    }

    // Build floating button HTML
    floatingContainer.innerHTML = "";
    floatingContainer.style.display = "flex";

    for (const quest of mobileQuests) {
        const questId: string = quest.id;
        const questName: string =
            quest.config?.messages?.questName ??
            quest.config?.application?.name ??
            `Quest ${questId}`;
        const isEnrolled = !!quest.userStatus?.enrolledAt;
        const isCompleted = !!quest.userStatus?.completedAt;

        const btn = document.createElement("button");
        btn.style.cssText = `
            background: ${isCompleted ? "#3ba55c" : isEnrolled ? "#5865f2" : "#ed4245"};
            color: white;
            border: none;
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 600;
            cursor: ${isEnrolled ? "default" : "pointer"};
            margin: 2px 0;
            font-family: inherit;
        `;
        btn.textContent = isCompleted
            ? `✅ ${questName}`
            : isEnrolled
                ? `📱 ${questName} (enrolled)`
                : `📱 Start: ${questName}`;

        if (!isEnrolled && !isCompleted) {
            btn.addEventListener("click", () => enrollInQuest(questId, questName));
        }
        floatingContainer.appendChild(btn);
    }
}

function createFloatingUI() {
    if (floatingContainer) return;

    const wrapper = document.createElement("div");
    wrapper.id = "vc-mobile-spoof-float";
    wrapper.style.cssText = `
        position: fixed;
        bottom: 60px;
        right: 16px;
        z-index: 9999;
        display: none;
        flex-direction: column;
        gap: 4px;
        pointer-events: all;
        background: rgba(30,31,34,0.95);
        border: 1px solid #5865f2;
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        min-width: 220px;
        max-width: 320px;
    `;

    const label = document.createElement("div");
    label.style.cssText = "color: #b5bac1; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; font-family: inherit;";
    label.textContent = "📱 Mobile Quests";
    wrapper.appendChild(label);

    floatingContainer = document.createElement("div");
    floatingContainer.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    wrapper.appendChild(floatingContainer);

    document.body.appendChild(wrapper);
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
        // ── 1. WebSocket — patch Gateway IDENTIFY (mobile status dot) ─────────
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

        // ── 2. getSuperProperties — patch REST API mobile fingerprint ─────────
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

        // ── 3. Floating UI — deferred until document.body exists ─────────────
        // At StartAt.Init, document.body may be null — poll until it's ready
        observer = new MutationObserver(() => updateFloatingUI());

        const initUI = () => {
            if (!document.body) {
                uiInitTimeout = setTimeout(initUI, 100);
                return;
            }
            createFloatingUI();
            updateFloatingUI();
            observer!.observe(document.body, { childList: true, subtree: true });
        };
        initUI();
    },

    stop() {
        if (uiInitTimeout) { clearTimeout(uiInitTimeout); uiInitTimeout = null; }
        if (originalWsSend) { WebSocket.prototype.send = originalWsSend; originalWsSend = null; }
        if (patchedModule) {
            if (originalGetSuperProperties) { patchedModule.getSuperProperties = originalGetSuperProperties; originalGetSuperProperties = null; }
            if (originalGetSuperPropertiesBase64) { patchedModule.getSuperPropertiesBase64 = originalGetSuperPropertiesBase64; originalGetSuperPropertiesBase64 = null; }
            patchedModule = null;
        }
        if (observer) { observer.disconnect(); observer = null; }
        document.getElementById("vc-mobile-spoof-float")?.remove();
        floatingContainer = null;
    }
});
